export const UPDATE_REPO = 'Dong2003610/hongyi-pet';
export const UPDATE_BASE = `https://github.com/${UPDATE_REPO}/releases`;
export const UPDATE_MANIFEST = `${UPDATE_BASE}/latest/download/update-manifest.json`;
export const MAX_UPDATE_BYTES = 500 * 1024 * 1024;
export interface UpdateRelease { version: string; notes: string; name: string; size: number; sha256: string; url: string }
export function versionParts(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) return;
  return value.split('.').map(Number);
}
export function newerVersion(next: string, current: string): boolean {
  const a = versionParts(next), b = versionParts(current); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! > b[i]!; }
  return false;
}
export function parseUpdateManifest(input: unknown): UpdateRelease {
  const raw = input as any, asset = raw?.windows;
  if (raw?.schema !== 1 || !versionParts(raw.version) || !asset || asset.name !== `hongyi-pet-win32-x64-v${raw.version}.zip`
    || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_UPDATE_BYTES || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('更新清单不完整或格式不正确');
  return { version: raw.version, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '', name: asset.name,
    size: asset.size, sha256: asset.sha256, url: `${UPDATE_BASE}/download/v${raw.version}/${asset.name}` };
}
export function updateUrlAllowed(raw: string): boolean {
  try {
    const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) return true;
    const prefix = `/${UPDATE_REPO}/releases/`;
    if (url.hostname === 'github.com') return url.pathname.startsWith(prefix);
    if (url.hostname === 'ghfast.top') return url.pathname.startsWith(`/https://github.com${prefix}`);
    return false;
  } catch { return false; }
}
export function mirrorUrl(url: string): string { return `https://ghfast.top/${url}`; }
export async function updateResponse(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  for (let i = 0; i < 6; i++) {
    if (!updateUrlAllowed(url)) throw new Error('更新下载地址不受信任');
    const response = await fetcher(url, { signal, redirect: 'manual', headers: { Accept: 'application/octet-stream, application/json' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get('location');
      if (!location) throw new Error('更新下载重定向缺少地址'); url = new URL(location, url).href; continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(response.status === 404 ? '还没有可用的正式更新版本' : `更新服务暂不可用（HTTP ${response.status}）`); }
    return response;
  }
  throw new Error('更新下载重定向次数过多');
}
export async function boundedText(response: Response, max: number): Promise<string> {
  const reader = response.body!.getReader(); const buffers: Uint8Array[] = []; let total = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length;
    if (total > max) throw new Error('更新清单过大'); buffers.push(value);
  } } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(buffers).toString('utf8');
}
