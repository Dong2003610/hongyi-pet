import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(await fs.readFile(path.join(root, 'tools/motion-registration.json'), 'utf8'));
const source = path.resolve(root, profile.source);
const original = JSON.parse(await fs.readFile(path.join(source, 'pet-spec.json'), 'utf8'));
const spec = JSON.parse(await fs.readFile(path.join(root, 'pet-spec.json'), 'utf8'));
const destination = path.join(root, 'src/assets/pet');
const qa = path.join(root, 'qa/20261030-motion');
await fs.mkdir(qa, { recursive: true });

export async function visibleBounds(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * info.channels + 3] <= 32) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < 0) throw new Error('Empty motion frame');
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

const records = [];
for (const state of spec.states) {
  const rule = profile.rules[state.id];
  if (!rule) throw new Error(`Missing registration rule: ${state.id}`);
  const inputState = original.states.find(s => s.id === state.id);
  for (const frame of state.frames) {
    const bytes = await fs.readFile(path.join(source, frame));
    if (createHash('sha256').update(bytes).digest('hex') !== profile.sourceHashes[frame])
      throw new Error(`Source changed; review landmarks before registration: ${frame}`);
    const before = await visibleBounds(bytes);
    if (rule.mode === 'original') {
      await fs.writeFile(path.join(destination, frame), bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      records.push({ state: state.id, frame, scale: 1, before, after: before, sourceSha256: hash, outputSha256: hash });
      continue;
    }
    const index = inputState.frames.indexOf(frame);
    const scale = rule.mode === 'height' ? rule.target / before.height
      : rule.mode === 'face' ? profile.referenceFace / rule.measurements[index] : 1;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1.02) throw new Error(`Unsafe scale: ${frame}`);
    // Resize the original once, then translate on the transparent canvas. No
    // independent X/Y stretching, artificial poses, or repeated downsampling.
    const size = Math.round(profile.canvas * scale);
    const resized = await sharp(bytes).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
    const bounds = await visibleBounds(resized);
    const left = Math.round(profile.centerX - (bounds.left + bounds.right) / 2);
    const top = profile.baseline - bounds.bottom;
    if (left < 0 || top < 0 || left + size > profile.canvas || top + size > profile.canvas) {
      // At scale=1, current frames need at most a two-pixel translation. Crop
      // only fully transparent margins, never the visible subject.
      const crop = { left: Math.max(0, -left), top: Math.max(0, -top),
        width: Math.min(size, profile.canvas - left) - Math.max(0, -left),
        height: Math.min(size, profile.canvas - top) - Math.max(0, -top) };
      if (bounds.left < crop.left || bounds.top < crop.top || bounds.right >= crop.left + crop.width || bounds.bottom >= crop.top + crop.height)
        throw new Error(`Registration clips the subject: ${frame}`);
      const image = await sharp(resized).extract(crop).png().toBuffer();
      await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00000000' } })
        .composite([{ input: image, left: Math.max(0, left), top: Math.max(0, top) }]).png().toFile(path.join(destination, frame));
    } else {
      await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00000000' } })
        .composite([{ input: resized, left, top }]).png().toFile(path.join(destination, frame));
    }
    const output = await fs.readFile(path.join(destination, frame));
    const after = await visibleBounds(output);
    records.push({ state: state.id, frame, scale, before, after,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      outputSha256: createHash('sha256').update(output).digest('hex') });
  }
}
const retained = new Set(spec.states.flatMap(s => s.frames));
const deferred = original.states.flatMap(s => s.frames).filter(f => !retained.has(f));
for (const frame of deferred) {
  // Every removed runtime frame remains intact in the source archive.
  await fs.access(path.join(source, frame));
  await fs.unlink(path.join(destination, frame)).catch(e => { if (e.code !== 'ENOENT') throw e; });
}
await fs.writeFile(path.join(qa, 'registration.json'), JSON.stringify({ profile, deferred, records }, null, 2) + '\n');
console.log(`Motion registration: ${records.length} frames; ${deferred.length} discontinuous poses archived.`);
