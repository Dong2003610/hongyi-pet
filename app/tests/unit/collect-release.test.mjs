import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
const execute = promisify(execFile);
const script = path.resolve('tools/collect-release.mjs');
test('collecting repeated releases preserves portable installs and older archives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hongyi-collect-'));
  try {
    await mkdir(path.join(root, 'release/current-portable'), { recursive: true });
    await mkdir(path.join(root, 'out/make'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'test-pet', version: '1.1.7' }));
    await writeFile(path.join(root, 'pet-spec.json'), JSON.stringify({ app: { name: 'test-pet', version: '1.1.7' } }));
    await writeFile(path.join(root, 'release/current-portable/pet.exe'), 'running portable');
    await writeFile(path.join(root, 'release/old.zip'), 'old archive');
    await writeFile(path.join(root, 'out/make/test-pet.zip'), 'new archive');
    for (let index = 0; index < 2; index++) await execute(process.execPath, [script, '--mode=make', '--platform=win32', '--arch=x64'], { cwd: root, windowsHide: true });
    assert.equal(await readFile(path.join(root, 'release/current-portable/pet.exe'), 'utf8'), 'running portable');
    assert.equal(await readFile(path.join(root, 'release/old.zip'), 'utf8'), 'old archive');
    assert.equal(await readFile(path.join(root, 'release/test-pet.zip'), 'utf8'), 'new archive');
    const manifest = JSON.parse(await readFile(path.join(root, 'release/manifest.json'), 'utf8'));
    assert.equal(manifest.artifacts[0].file, 'test-pet-1.zip');
  } finally { await rm(root, { recursive: true, force: true }); }
});
