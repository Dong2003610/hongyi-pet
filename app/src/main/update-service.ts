import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateStatus } from '../shared/contracts';
import { boundedText, mirrorUrl, newerVersion, parseGithubRelease, parseUpdateManifest, UPDATE_API, UPDATE_MANIFEST, updateResponse, type UpdateRelease } from './update-feed';
import { downloadArchive } from './update-download';

interface Preferences { autoCheck: boolean; useMirror: boolean; notified?: string }
interface Options {
  version: string; supported: boolean; directory: string;
  load: () => Promise<unknown>; save: (value: unknown) => Promise<void>;
  prepare: (archive: string, release: UpdateRelease, id: string) => Promise<void>;
  discard?: (id: string) => Promise<void>;
  changed: (status: AppUpdateStatus) => void;
  fetch?: typeof fetch; now?: () => number;
}
export class AppUpdateService {
  private prefs: Preferences = { autoCheck: true, useMirror: true };
  private value: AppUpdateStatus;
  private release?: UpdateRelease;
  private checking?: Promise<AppUpdateStatus>;
  private downloading?: Promise<string>;
  private controller?: AbortController;
  private lastAttempt = -Infinity;
  private lastAutomatic = -Infinity;
  private jobId?: string;
  private cached?: { id: string; sha256: string; size: number; version: string };
  private configureQueue: Promise<unknown> = Promise.resolve();
  constructor(private options: Options) {
    this.value = { phase: options.supported ? 'idle' : 'unsupported', currentVersion: options.version, autoCheck: true, useMirror: true,
      message: options.supported ? '尚未检查更新' : '自动替换仅支持 Windows x64 正式便携版；开发模式可查看界面。' };
  }
  async restore(): Promise<void> {
    try { const raw = await this.options.load() as Partial<Preferences>;
      if (typeof raw?.autoCheck === 'boolean' && typeof raw.useMirror === 'boolean') this.prefs = { autoCheck: raw.autoCheck, useMirror: raw.useMirror,
        notified: typeof raw.notified === 'string' ? raw.notified : undefined };
    } catch { /* Missing settings retain defaults. */ }
    try {
      const cache = JSON.parse(await readFile(path.join(this.options.directory, 'partial-update.json'), 'utf8'));
      if (/^[a-f0-9]{32}$/.test(cache.id) && /^[a-f0-9]{64}$/.test(cache.sha256) && Number.isSafeInteger(cache.size) && cache.size > 0 && typeof cache.version === 'string') this.cached = cache;
    } catch { /* Interrupted metadata writes simply require a fresh download. */ }
    this.publish({});
  }
  status(): AppUpdateStatus { return { ...this.value, autoCheck: this.prefs.autoCheck, useMirror: this.prefs.useMirror }; }
  private publish(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
    Object.assign(this.value, patch); const snapshot = this.status(); this.options.changed(snapshot); return snapshot;
  }
  async configure(input: unknown): Promise<AppUpdateStatus> {
    const raw = input as Preferences;
    if (!raw || Object.keys(raw).some(k => !['autoCheck', 'useMirror'].includes(k)) || typeof raw.autoCheck !== 'boolean' || typeof raw.useMirror !== 'boolean') throw new Error('更新设置无效');
    const operation = this.configureQueue.then(async () => {
      const next = { ...this.prefs, autoCheck: raw.autoCheck, useMirror: raw.useMirror };
      await this.options.save(next); this.prefs = next; return this.publish({});
    }); this.configureQueue = operation.catch(() => {}); return operation;
  }
  async check(automatic = false): Promise<AppUpdateStatus> {
    if (!this.options.supported || this.downloading || ['ready', 'installing'].includes(this.value.phase)) return this.status();
    if (this.checking) return this.checking;
    const now = (this.options.now ?? Date.now)();
    if (automatic && (!this.prefs.autoCheck || now - this.lastAutomatic < 6 * 3600000) || now - this.lastAttempt < 60000) return this.status();
    this.lastAttempt = now; this.lastAutomatic = now; this.publish({ phase: 'checking', message: '正在检查新版本…' });
    this.checking = (async () => {
      try {
        let release: UpdateRelease | undefined, error: unknown;
        for (const url of [UPDATE_API, ...this.urls(UPDATE_MANIFEST)]) {
          try { const raw = JSON.parse(await boundedText(await updateResponse(url, AbortSignal.timeout(15000), this.options.fetch), url === UPDATE_API ? 256000 : 64000)); release = url === UPDATE_API ? parseGithubRelease(raw) : parseUpdateManifest(raw); break; } catch (e) { error = e; }
        }
        if (!release) throw error;
        if (!newerVersion(release.version, this.options.version)) {
          this.release = undefined; return this.publish({ phase: 'current', latestVersion: undefined, notes: undefined, message: '已经是最新版本', checkedAt: new Date(now).toISOString() });
        }
        this.release = release;
        return this.publish({ phase: 'available', latestVersion: release.version, notes: release.notes, message: `发现新版本 ${release.version}`, checkedAt: new Date(now).toISOString() });
      } catch (e) {
        this.lastAutomatic = now - 6 * 3600000 + 15 * 60000;
        return this.publish({ phase: 'error', message: e instanceof Error ? e.message : '检查更新失败，可稍后重试' });
      }
    })().finally(() => { this.checking = undefined; }); return this.checking;
  }
  private urls(url: string): string[] { return this.prefs.useMirror ? [mirrorUrl(url), url] : [url]; }
  notification(): string | undefined { return this.release && this.prefs.autoCheck && this.prefs.notified !== this.release.version ? this.release.version : undefined; }
  async notified(version: string): Promise<void> {
    const operation = this.configureQueue.then(async () => {
      if (this.release?.version !== version) return;
      const next = { ...this.prefs, notified: version }; await this.options.save(next); this.prefs = next;
    }); this.configureQueue = operation.catch(() => {}); await operation;
  }
  cancel(): void { this.controller?.abort(); }
  async download(): Promise<string> {
    if (this.downloading) return this.downloading;
    if (this.value.phase === 'ready' && this.jobId) return this.jobId;
    if (!this.options.supported || !this.release || !['available', 'error'].includes(this.value.phase)) throw new Error('请先检查并选择可用的新版本');
    const release = { ...this.release };
    const stale = this.cached && (this.cached.sha256 !== release.sha256 || this.cached.size !== release.size || this.cached.version !== release.version) ? this.cached : undefined;
    const id = (!stale && this.cached?.id) || randomBytes(16).toString('hex');
    this.controller = new AbortController(); const controller = this.controller;
    this.publish({ phase: 'downloading', progress: 0, message: '正在下载更新；完成后会自动重启' });
    this.downloading = (async () => {
      const directory = path.join(this.options.directory, id); const archive = path.join(directory, 'update.zip');
      let verified = false;
      try {
        if (stale) { await rm(path.join(this.options.directory, stale.id), { recursive: true, force: true }); this.cached = undefined; }
        await mkdir(directory, { recursive: true });
        this.cached = { id, sha256: release.sha256, size: release.size, version: release.version };
        await writeFile(path.join(this.options.directory, 'partial-update.json'), JSON.stringify(this.cached));
        await downloadArchive({ archive, release, signal: controller.signal, fetch: this.options.fetch,
          urls: this.prefs.useMirror ? [mirrorUrl(release.url), ...(release.apiUrl ? [release.apiUrl] : []), release.url] : [...(release.apiUrl ? [release.apiUrl] : []), release.url],
          progress: ({ bytes, speed, source, switching }) => {
            const mib = (value: number) => (value / 1048576).toFixed(1);
            const rate = speed >= 1048576 ? `${mib(speed)} MB/s` : `${(speed / 1024).toFixed(0)} KB/s`;
            const remaining = speed > 0 ? Math.ceil((release.size - bytes) / speed) : 0;
            const eta = remaining > 0 ? ` · 约剩 ${remaining >= 60 ? `${Math.ceil(remaining / 60)} 分钟` : `${remaining} 秒`}` : '';
            this.publish({ progress: Math.floor(bytes * 100 / release.size), message: `${switching ? '正在切换至' : '正在下载 · '}${source} · ${mib(bytes)} / ${mib(release.size)} MB${speed > 0 ? ` · ${rate}${eta}` : ''}` });
          },
        });
        verified = true; this.cached = { id, sha256: release.sha256, size: release.size, version: release.version };
        controller.signal.throwIfAborted(); this.publish({ phase: 'preparing', progress: 100, message: '正在校验并准备更新…' });
        await this.options.prepare(archive, release, id);
        controller.signal.throwIfAborted(); this.jobId = id;
        this.publish({ phase: 'ready', message: '更新已准备好，即将退出并重启' }); return id;
      } catch (e) {
        await this.options.discard?.(id).catch(() => {});
        // Keep partial bytes for Range retries, even across app restarts. Their
        // version/size/hash identity is persisted; only a full SHA-256 match installs.
        this.publish({ phase: controller.signal.aborted ? 'available' : 'error', progress: undefined,
          message: controller.signal.aborted ? '已暂停下载，进度已保留；再次下载可继续，当前版本继续运行' : `${e instanceof Error ? e.message : '更新准备失败，当前版本未改变'}${verified ? '（下载包已保留，再次点击可直接重试）' : '（已保留下载进度，可重试续传）'}` }); throw e;
      } finally { this.controller = undefined; }
    })().finally(() => { this.downloading = undefined; }); return this.downloading;
  }
  installing(): void { this.publish({ phase: 'installing', message: '正在安全退出并替换程序，请稍候…' }); }
  startupNotice(message: string): void { this.publish({ message }); }
  installFailed(message: string): void { this.publish({ phase: 'ready', message }); }
}
