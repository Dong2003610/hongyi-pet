import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson, readValidatedJson } from '../../src/main/persistence';
import { parseChatHistory, parseSettings } from '../../src/main/data-validation';
import type { Settings } from '../../src/shared/contracts';

test('chat history preserves valid timestamps and keeps legacy or invalid times unknown', () => {
  const messages = parseChatHistory([
    { role: 'user', content: '开始专注', createdAt: '2026-11-12T10:20:00+08:00' },
    { role: 'assistant', content: '旧记录' },
    { role: 'assistant', content: '错误时间', createdAt: 'invalid' },
  ]);
  assert.equal(messages[0]!.createdAt, '2026-11-12T02:20:00.000Z');
  assert.equal(messages[1]!.createdAt, undefined);
  assert.equal(messages[2]!.createdAt, undefined);
  assert.equal(parseChatHistory(JSON.parse(JSON.stringify(messages)))[0]!.createdAt, messages[0]!.createdAt);
});

const defaults: Settings = {
  edgeSnap: true,
  alwaysOnTop: true,
  typingReaction: false,
  clickThrough: false,
  petScale: 1,
  openAtLogin: false,
  soundEnabled: true,
  sedentaryReminder: true,
};

test('atomic JSON persistence round-trips without temporary files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-persistence-'));
  try {
    const file = path.join(directory, 'settings.json');
    await atomicWriteJson(file, defaults);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), defaults);
    assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid persisted data is backed up and defaults are restored', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-corrupt-'));
  try {
    const file = path.join(directory, 'settings.json');
    await writeFile(file, '{"edgeSnap":"yes"}', 'utf8');
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings), defaults);
    const names = await readdir(directory);
    assert.equal(names.includes('settings.json'), false);
    assert.equal(names.some((name) => name.startsWith('settings.json.') && name.endsWith('.corrupt')), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing persistence files use defaults without a corrupt backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-pet-missing-'));
  try {
    const file = path.join(directory, 'settings.json');
    assert.deepEqual(await readValidatedJson(file, defaults, parseSettings), defaults);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
