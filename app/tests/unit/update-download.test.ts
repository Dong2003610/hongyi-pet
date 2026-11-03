import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadArchive } from '../../src/main/update-download';
import { parseUpdateManifest } from '../../src/main/update-feed';

const data = Buffer.from('a verified portable update archive');
const release = parseUpdateManifest({ schema: 1, version: '1.2.0', windows: { name: 'hongyi-pet-win32-x64-v1.2.0.zip', size: data.length, sha256: createHash('sha256').update(data).digest('hex') } });
const urls = [`https://ghfast.top/${release.url}`, release.url];
async function fixture(run: (archive: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-range-'));
  try { await run(path.join(directory, 'update.zip')); } finally { await rm(directory, { recursive: true, force: true }); }
}
function partial(offset: number) { return new Response(data.subarray(offset), { status: 206, headers: { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}`, 'content-length': String(data.length - offset) } }); }
test('resume uses the exact on-disk offset and verifies the combined archive', () => fixture(async archive => {
  await writeFile(archive, data.subarray(0, 7));
  await downloadArchive({ archive, release, urls, signal: new AbortController().signal, progress: () => {}, fetch: async (_url, init) => { assert.equal(new Headers(init?.headers).get('range'), 'bytes=7-'); return partial(7); } });
  assert.deepEqual(await readFile(archive), data);
}));
test('ignored Range restarts safely rather than appending duplicate bytes', () => fixture(async archive => {
  await writeFile(archive, data.subarray(0, 7));
  await downloadArchive({ archive, release, urls, signal: new AbortController().signal, progress: () => {}, fetch: async () => new Response(data) });
  assert.deepEqual(await readFile(archive), data);
}));
test('wrong Content-Range cannot alter a retained partial archive', () => fixture(async archive => {
  await writeFile(archive, data.subarray(0, 7));
  await assert.rejects(downloadArchive({ archive, release, urls, signal: new AbortController().signal, progress: () => {}, fetch: async () => partial(8) }), /续传范围/);
  assert.deepEqual(await readFile(archive), data.subarray(0, 7));
}));
test('stalled stream switches routes and resumes bytes already written', () => fixture(async archive => {
  let calls = 0;
  await downloadArchive({ archive, release, urls, stallMs: 10, signal: new AbortController().signal, progress: () => {}, fetch: async (_url, init) => {
    if (++calls > 1) { assert.equal(new Headers(init?.headers).get('range'), 'bytes=7-'); return partial(7); }
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 7)); init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true }); } }));
  } });
  assert.equal(calls, 2); assert.deepEqual(await readFile(archive), data);
}));
test('slow stream tries alternate route without throwing away progress', () => fixture(async archive => {
  let calls = 0;
  await downloadArchive({ archive, release, urls, slowMs: 1, slowBytes: 1e9, signal: new AbortController().signal, progress: () => {}, fetch: async (_url, init) => {
    if (++calls > 1) { assert.equal(new Headers(init?.headers).get('range'), 'bytes=7-'); return partial(7); }
    return new Response(new ReadableStream({ async pull(controller) { await new Promise(resolve => setTimeout(resolve, 5)); controller.enqueue(data.subarray(0, 7)); }, cancel() {} }));
  } });
  assert.equal(calls, 2); assert.deepEqual(await readFile(archive), data);
}));
test('a slow but working final route finishes rather than timing out repeatedly', () => fixture(async archive => {
  let calls = 0;
  await downloadArchive({ archive, release, urls: [urls[0]!], slowMs: 1, slowBytes: 1e9, signal: new AbortController().signal, progress: () => {}, fetch: async (_url, init) => {
    calls++; const offset = Number(/bytes=(\d+)-/.exec(new Headers(init?.headers).get('range') ?? '')?.[1] ?? 0);
    let sent = offset;
    return new Response(new ReadableStream({ async pull(controller) { await new Promise(resolve => setTimeout(resolve, 5)); if (sent === data.length) { controller.close(); return; } const next = Math.min(data.length, sent + 7); controller.enqueue(data.subarray(sent, next)); sent = next; } }), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {} });
  } });
  assert.equal(calls, 2); assert.deepEqual(await readFile(archive), data);
}));
test('tampered partial data fails full checksum and is redownloaded cleanly', () => fixture(async archive => {
  await writeFile(archive, Buffer.from('bad!!!!')); let calls = 0;
  await downloadArchive({ archive, release, urls, signal: new AbortController().signal, progress: () => {}, fetch: async (_url, init) => { calls++; return new Headers(init?.headers).has('range') ? partial(7) : new Response(data); } });
  assert.equal(calls, 2); assert.deepEqual(await readFile(archive), data);
}));
test('cancellation retains partial bytes and stops trying other routes', () => fixture(async archive => {
  const cancel = new AbortController(); let calls = 0;
  await assert.rejects(downloadArchive({ archive, release, urls, signal: cancel.signal, progress: value => { if (value.bytes > 0) cancel.abort(); }, fetch: async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 7)); } })); } }));
  assert.equal(calls, 1); assert.deepEqual(await readFile(archive), data.subarray(0, 7));
}));
