import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import spec from '../../pet-spec.json';
import { PetStateMachine } from '../../src/renderer/pet/state-machine';
import type { PetState } from '../../src/shared/contracts';

const assetRoot = path.resolve(__dirname, '../../src/assets/pet');

test('runtime art stays transparent, unclipped and on the common baseline at every frame', async () => {
  const walkingHeights: number[] = [];
  for (const state of spec.states) for (const frame of state.frames) {
    const bytes = await readFile(path.join(assetRoot, frame));
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 512, frame);
    assert.equal(info.height, 512, frame);
    let top = 512, bottom = -1, left = 512, right = -1;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const alpha = data[(y * 512 + x) * 4 + 3]!;
      if (x === 0 || y === 0 || x === 511 || y === 511) assert.equal(alpha, 0, `clipped edge: ${frame}`);
      if (alpha <= 32) continue;
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      left = Math.min(left, x); right = Math.max(right, x);
    }
    if (state.id !== 'sleep') {
      assert.equal(bottom, 485, `foot/ground contact drifts: ${frame}`);
      assert.ok(Math.abs((left + right) / 2 - 256) <= 1, `horizontal registration: ${frame}`);
    }
    if (state.id.startsWith('walk-')) walkingHeights.push(bottom - top + 1);
  }
  assert.ok(Math.max(...walkingHeights) - Math.min(...walkingHeights) <= 2,
    'walking must not change body height between steps or facing directions');
});

test('original art remains recoverable and only approved states use the removed poses', async () => {
  const originalRoot = path.resolve(__dirname, '../../../incoming-assets/motion-originals-20261030');
  const original = JSON.parse(await readFile(path.join(originalRoot, 'pet-spec.json'), 'utf8'));
  const hashes = JSON.parse(await readFile(path.resolve(__dirname, '../../tools/motion-registration.json'), 'utf8')).sourceHashes;
  for (const frame of original.states.flatMap((s: { frames: string[] }) => s.frames)) {
    const bytes = await readFile(path.join(originalRoot, frame));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[frame], `original changed: ${frame}`);
  }
  assert.ok(!spec.states.find(s => s.id === 'eat')!.frames.includes('eat-04.png'));
  for (const id of ['walk-left', 'walk-right']) {
    const state = spec.states.find(s => s.id === id)!;
    assert.ok(state.frames.length >= 4);
    assert.ok(!state.frames.some(f => f.endsWith('-06.png')), 'standing is not a walking step');
  }
});

test('sleep preserves all original artwork and each pose lasts 2.5 seconds', async () => {
  const sleep = spec.states.find(s => s.id === 'sleep')!;
  const interaction = spec.experience.interactions.find(i => i.id === 'go-sleep')!;
  assert.deepEqual(sleep.frames, Array.from({ length: 6 }, (_,i) => `sleep-0${i + 1}.png`));
  for (const frame of sleep.frames) {
    const original = await readFile(path.resolve(__dirname, '../../../incoming-assets/motion-originals-20261030', frame));
    assert.deepEqual(await readFile(path.join(assetRoot, frame)), original, `sleep art was changed: ${frame}`);
  }
  const machine = new PetStateMachine(spec.states as PetState[], 0);
  machine.start('sleep', 0, interaction.durationMs, true);
  for (const [i, frame] of sleep.frames.entries()) {
    assert.equal(machine.tick(i * 2500).frame, frame);
    assert.equal(machine.tick(i * 2500 + 2499).frame, frame);
  }
  assert.equal(machine.tick(15000).stateId, 'idle');
});
