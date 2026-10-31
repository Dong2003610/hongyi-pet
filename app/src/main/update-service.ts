import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppUpdateStatus } from '../shared/contracts';
import { boundedText, mirrorUrl, newerVersion, parseUpdateManifest, UPDATE_MANIFEST, updateResponse, type UpdateRelease } from './update-feed';

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
        let text: string | undefined, error: unknown;
        for (const url of this.urls(UPDATE_MANIFEST)) {
          try { text = await boundedText(await updateResponse(url, AbortSignal.timeout(15000), this.options.fetch), 64000); break; } catch (e) { error = e; }
        }
        if (!text) throw error;
        const release = parseUpdateManifest(JSON.parse(text));
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
    const release = { ...this.release }, id = randomBytes(16).toString('hex');
    this.controller = new AbortController(); const controller = this.controller;
    const timer = setTimeout(() => controller.abort(), 5 * 60000);
    this.publish({ phase: 'downloading', progress: 0, message: '正在下载更新；完成后会自动重启' });
    this.downloading = (async () => {
      const directory = path.join(this.options.directory, id); const archive = path.join(directory, 'update.zip');
      try {
        await mkdir(directory, { recursive: true });
        let lastError: unknown, success = false;
        for (const url of this.urls(release.url)) {
          if (controller.signal.aborted) break;
          try {
            const response = await updateResponse(url, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]), this.options.fetch);
            const expectedSize = Number(response.headers.get('content-length'));
            if (expectedSize && expectedSize !== release.size) { await response.body?.cancel(); throw new Error('更新包大小与发布清单不一致'); }
            const file = await open(archive, 'w'), reader = response.body!.getReader(), digest = createHash('sha256');
            let total = 0, lastProgress = 0;
            try { for (;;) {
              const { done, value } = await reader.read(); if (done) break; controller.signal.throwIfAborted();
              total += value.length; if (total > release.size) throw new Error('更新包超出声明大小');
              await file.writeFile(value); digest.update(value);
              if (Date.now() - lastProgress > 200) { lastProgress = Date.now(); this.publish({ progress: Math.floor(total * 100 / release.size) }); }
            } } finally { await file.close(); await reader.cancel().catch(() => {}); }
            if (total !== release.size || digest.digest('hex') !== release.sha256) throw new Error('更新包 SHA-256 校验失败，请重新下载');
            success = true; break;
          } catch (e) { lastError = e; }
        }
        if (!success) throw lastError ?? new Error('下载已取消');
        controller.signal.throwIfAborted(); this.publish({ phase: 'preparing', progress: 100, message: '正在校验并准备更新…' });
        await this.options.prepare(archive, release, id);
        controller.signal.throwIfAborted(); this.jobId = id;
        this.publish({ phase: 'ready', message: '更新已准备好，即将退出并重启' }); return id;
      } catch (e) {
        await this.options.discard?.(id).catch(() => {});
        // Only the unique download job directory is disposable; never app/user data.
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        this.publish({ phase: controller.signal.aborted ? 'available' : 'error', progress: undefined,
          message: controller.signal.aborted ? '已取消下载，当前版本继续运行' : e instanceof Error ? e.message : '更新准备失败，当前版本未改变' }); throw e;
      } finally { clearTimeout(timer); this.controller = undefined; }
    })().finally(() => { this.downloading = undefined; }); return this.downloading;
  }
  installing(): void { this.publish({ phase: 'installing', message: '正在安全退出并替换程序，请稍候…' }); }
  startupNotice(message: string): void { this.publish({ message }); }
  installFailed(message: string): void { this.publish({ phase: 'ready', message }); }
}
