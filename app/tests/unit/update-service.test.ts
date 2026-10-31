import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppUpdateService } from '../../src/main/update-service';
import { newerVersion, parseGithubRelease, parseUpdateManifest, UPDATE_API, updateResponse, updateUrlAllowed } from '../../src/main/update-feed';

const bytes = Buffer.from('test update archive');
const apiMiss = (url: unknown) => String(url) === UPDATE_API;
const noApi = () => new Response('not found', { status: 404 });
function manifest(version = '1.2.0') { return { schema: 1, version, notes: '新功能', windows: { name: `hongyi-pet-win32-x64-v${version}.zip`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }; }
async function fixture(extra: Partial<ConstructorParameters<typeof AppUpdateService>[0]> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-update-unit-'));
  const states: any[] = []; let calls = 0, prepared = 0, saved: any;
  const service = new AppUpdateService({ directory, version: '1.1.0', supported: true, now: () => 100000,
    load: async () => saved, save: async value => { saved = structuredClone(value); },
    fetch: async url => { if (apiMiss(url)) return noApi(); calls++; return String(url).endsWith('.json') ? Response.json(manifest()) : new Response(bytes); },
    prepare: async archive => { assert.deepEqual(await readFile(archive), bytes); prepared++; }, changed: state => states.push(state), ...extra });
  return { service, directory, states, calls: () => calls, prepared: () => prepared, saved: () => saved,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('update versions use numeric semver and manifests reject untrusted metadata', () => {
  assert.equal(newerVersion('1.10.0', '1.9.0'), true); assert.equal(newerVersion('1.1.0', '1.1.0'), false);
  for (const version of ['1.2.0-beta', '01.2.0', 'v1.2.0', '../x', 'https://evil']) assert.throws(() => parseUpdateManifest(manifest(version)));
  assert.equal(parseUpdateManifest(manifest()).url, 'https://github.com/Dong2003610/hongyi-pet/releases/download/v1.2.0/hongyi-pet-win32-x64-v1.2.0.zip');
  for (const windows of [{ ...manifest().windows, size: Infinity }, { ...manifest().windows, name: 'evil.exe' }, { ...manifest().windows, sha256: 'invalid' }]) assert.throws(() => parseUpdateManifest({ ...manifest(), windows }));
});
test('download URLs/redirects reject arbitrary hosts and insecure schemes', async () => {
  for (const url of ['http://github.com/Dong2003610/hongyi-pet/releases/x', 'https://localhost/x', 'https://github.com/evil/repo/releases/x', 'https://github.com.evil.test/x', 'https://a@github.com/Dong2003610/hongyi-pet/releases/x', 'file:///a']) assert.equal(updateUrlAllowed(url), false);
  await assert.rejects(updateResponse(parseUpdateManifest(manifest()).url, new AbortController().signal, async () => new Response(null, { status: 302, headers: { location: 'https://localhost/private' } })), /不受信任/);
});
test('unsupported/dev mode makes no network request and cannot install', async () => {
  const f = await fixture({ supported: false });
  try { assert.equal((await f.service.check()).phase, 'unsupported'); assert.equal(f.calls(), 0); await assert.rejects(f.service.download()); } finally { await f.cleanup(); }
});
test('check coalesces, prompts once per version, persists preferences and validates config', async () => {
  const f = await fixture();
  try {
    await f.service.restore(); await Promise.all([f.service.check(), f.service.check()]); assert.equal(f.calls(), 1);
    assert.equal(f.service.status().phase, 'available'); assert.equal(f.service.notification(), '1.2.0');
    await f.service.notified('1.2.0'); assert.equal(f.service.notification(), undefined);
    assert.equal(f.saved().notified, '1.2.0');
    await f.service.configure({ autoCheck: false, useMirror: false }); await f.service.check(true); assert.equal(f.calls(), 1);
    await assert.rejects(f.service.configure({ autoCheck: true, useMirror: false, url: 'https://evil' }));
  } finally { await f.cleanup(); }
});
test('downgrades and equal versions never produce an installable update', async () => {
  const f = await fixture({ fetch: async url => apiMiss(url) ? noApi() : Response.json(manifest('1.0.9')) });
  try { assert.equal((await f.service.check()).phase, 'current'); assert.equal(f.service.notification(), undefined); await assert.rejects(f.service.download()); } finally { await f.cleanup(); }
});
test('download coalesces, verifies bytes/hash before preparing and uses a unique job', async () => {
  const f = await fixture();
  try {
    await f.service.check(); const [a, b] = await Promise.all([f.service.download(), f.service.download()]);
    assert.equal(a, b); assert.match(a, /^[a-f0-9]{32}$/); assert.equal(f.prepared(), 1);
    assert.equal(f.service.status().phase, 'ready'); assert.equal(await f.service.download(), a);
    assert.ok(f.states.some(s => s.phase === 'preparing'));
  } finally { await f.cleanup(); }
});
test('corrupt or truncated package never reaches prepare; old app is untouched', async () => {
  let prepared = false;
  const f = await fixture({ fetch: async url => apiMiss(url) ? noApi() : String(url).endsWith('.json') ? Response.json(manifest()) : new Response('wrong'), prepare: async () => { prepared = true; } });
  try { await f.service.check(); await assert.rejects(f.service.download(), /校验失败/); assert.equal(prepared, false); assert.equal(f.service.status().phase, 'error'); } finally { await f.cleanup(); }
});
test('cancel during download returns to available without preparing', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ fetch: async url => { if (apiMiss(url)) return noApi(); if (String(url).endsWith('.json')) return Response.json(manifest()); await gate; return new Response(bytes); } });
  try { await f.service.check(); const downloading = f.service.download(); f.service.cancel(); release(); await assert.rejects(downloading); assert.equal(f.prepared(), 0); assert.equal(f.service.status().phase, 'available'); } finally { await f.cleanup(); }
});
test('mirror failure falls back to original source and reports preparation failure safely', async () => {
  const urls: string[] = [];
  let discarded: string | undefined;
  const f = await fixture({ fetch: async url => { if (apiMiss(url)) return noApi(); urls.push(String(url)); if (String(url).includes('ghfast.top')) throw new Error('mirror down'); return String(url).endsWith('.json') ? Response.json(manifest()) : new Response(bytes); }, prepare: async () => { throw new Error('directory not writable'); }, discard: async id => { discarded = id; } });
  try { await f.service.check(); await assert.rejects(f.service.download(), /not writable/); assert.equal(f.service.status().phase, 'error'); assert.match(discarded!, /^[a-f0-9]{32}$/); await assert.rejects(readFile(path.join(f.directory, discarded!, 'update.zip'))); assert.ok(urls.some(u => u.startsWith('https://github.com/'))); } finally { await f.cleanup(); }
});

test('public GitHub API discovers release and downloads through asset API when mirror fails', async () => {
  const metadata = { tag_name: 'v1.2.0', draft: false, prerelease: false, body: 'release', assets: [{ id: 123, state: 'uploaded', name: manifest().windows.name, size: bytes.length, digest: 'sha256:' + manifest().windows.sha256 }] };
  assert.equal(parseGithubRelease(metadata).apiUrl, 'https://api.github.com/repos/Dong2003610/hongyi-pet/releases/assets/123');
  assert.throws(() => parseGithubRelease({ ...metadata, prerelease: true }));
  assert.throws(() => parseGithubRelease({ ...metadata, assets: [{ ...metadata.assets[0], digest: undefined }] }));
  assert.equal(updateUrlAllowed('https://api.github.com/repos/evil/repo/releases/assets/123'), false);
  const visited: string[] = [];
  const f = await fixture({ fetch: async url => { visited.push(String(url)); if (apiMiss(url)) return Response.json(metadata); if (String(url).includes('ghfast.top')) throw new Error('mirror unavailable'); return new Response(bytes); } });
  try { assert.equal((await f.service.check()).phase, 'available'); await f.service.download(); assert.ok(visited.some(url => url.endsWith('/releases/assets/123'))); assert.equal(f.prepared(), 1); } finally { await f.cleanup(); }
});
