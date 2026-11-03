import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, truncate } from 'node:fs/promises';
import { updateResponse, type UpdateRelease } from './update-feed';

export interface DownloadProgress { bytes: number; speed: number; source: string; switching?: boolean }
interface DownloadOptions {
  archive: string; release: UpdateRelease; urls: string[]; signal: AbortSignal; fetch?: typeof fetch;
  progress: (value: DownloadProgress) => void;
  headerMs?: number; stallMs?: number; slowMs?: number; slowBytes?: number;
}
async function sizeOf(file: string) { try { return (await stat(file)).size; } catch { return 0; } }
export async function verifiedArchive(file: string, release: UpdateRelease, signal: AbortSignal): Promise<boolean> {
  if (await sizeOf(file) !== release.size) return false;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
  return digest.digest('hex') === release.sha256;
}
export async function downloadArchive(options: DownloadOptions): Promise<void> {
  const { archive, release, signal } = options;
  if (await verifiedArchive(archive, release, signal)) return;
  if (await sizeOf(archive) >= release.size) await truncate(archive, 0);
  const rates = new Map<string, number>();
  let lastError: unknown;
  // Try each route once, then let the best measured route finish even if slow.
  // A working transfer has no fixed total deadline; stalled reads stay bounded.
  for (let index = 0; index <= options.urls.length; index++) {
    signal.throwIfAborted();
    const url = index < options.urls.length ? options.urls[index]! : [...rates].sort((a, b) => b[1] - a[1])[0]?.[0] ?? options.urls[0]!;
    const source = url.includes('ghfast.top') ? '镜像线路' : url.includes('api.github.com') ? 'GitHub API 线路' : 'GitHub 线路';
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let timer = setTimeout(() => controller.abort(new Error('更新线路连接超时')), options.headerMs ?? 20000);
    let response: Response | undefined;
    const started = Date.now(); let received = 0;
    let total = await sizeOf(archive);
    options.progress({ bytes: total, speed: 0, source, switching: index > 0 });
    try {
      response = await updateResponse(url, combined, options.fetch, total ? { Range: `bytes=${total}-` } : undefined);
      clearTimeout(timer);
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== total || Number(range[2]) !== release.size - 1 || Number(range[3]) !== release.size) throw new Error('更新包续传范围不正确');
      } else if (response.status === 200) {
        total = 0; // Server ignored Range: replace, never append a full file.
      } else throw new Error('更新包下载响应无效');
      const length = Number(response.headers.get('content-length'));
      if (length && length !== release.size - total) throw new Error('更新包大小与发布清单不一致');
      const file = await open(archive, total ? 'a' : 'w');
      const reader = response.body!.getReader();
      let lastProgress = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          timer = setTimeout(() => controller.abort(new Error('更新线路长时间没有数据，正在切换')), options.stallMs ?? 30000);
          const { done, value } = await reader.read(); clearTimeout(timer);
          combined.throwIfAborted(); if (done) break;
          if (total + value.length > release.size) throw new Error('更新包超出声明大小');
          await file.writeFile(value); total += value.length; received += value.length;
          const elapsed = Date.now() - started;
          const speed = received * 1000 / Math.max(1, elapsed);
          rates.set(url, speed);
          if (Date.now() - lastProgress > 250) { lastProgress = Date.now(); options.progress({ bytes: total, speed, source }); }
          if (total < release.size && index < options.urls.length && elapsed >= (options.slowMs ?? 20000) && speed < (options.slowBytes ?? 128 * 1024)) throw new Error('当前更新线路较慢，尝试备用线路');
        }
      } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); await file.close(); }
      if (await verifiedArchive(archive, release, signal)) { options.progress({ bytes: release.size, speed: received * 1000 / Math.max(1, Date.now() - started), source }); return; }
      if (total >= release.size) await truncate(archive, 0);
      throw new Error('更新包 SHA-256 校验失败，请重新下载');
    } catch (error) {
      lastError = error; signal.throwIfAborted();
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => {}); controller.abort(); }
  }
  throw lastError ?? new Error('更新下载暂不可用，可继续下载');
}
