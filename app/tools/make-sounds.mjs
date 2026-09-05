// 生成内置音效 wav 文件（纯 Node 实现，无第三方依赖）
// 用法: node tools/make-sounds.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SAMPLE_RATE = 22050;

function wavFromSamples(samples) {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

const sine = (freq, t) => Math.sin(2 * Math.PI * freq * t);

// eat: 两次短促的"咔嚓"声（噪声 + 低频闷响）
function makeEat() {
  const samples = new Array(Math.floor(0.24 * SAMPLE_RATE)).fill(0);
  const burst = (startSec, lenSec, level) => {
    const start = Math.floor(startSec * SAMPLE_RATE);
    const len = Math.floor(lenSec * SAMPLE_RATE);
    for (let i = 0; i < len; i += 1) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 45);
      const noise = (Math.random() * 2 - 1) * env * level;
      const thump = sine(170, t) * env * level * 0.6;
      samples[start + i] += noise + thump;
    }
  };
  burst(0, 0.07, 0.8);
  burst(0.11, 0.08, 0.6);
  return samples;
}

// pet: 轻快的"啵"声（正弦上滑 + 二次谐波）
function makePet() {
  const durSec = 0.26;
  const total = Math.floor(durSec * SAMPLE_RATE);
  const samples = [];
  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    const progress = i / total;
    const freq = 520 + 300 * progress;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const env = Math.sin(Math.PI * progress) ** 1.5;
    samples.push((Math.sin(phase) + 0.3 * Math.sin(2 * phase)) * env * 0.5);
  }
  return samples;
}

// notify: 叮咚双音（880Hz -> 1174Hz，指数衰减）
function makeNotify() {
  const samples = new Array(Math.floor(0.55 * SAMPLE_RATE)).fill(0);
  const tone = (startSec, lenSec, freq, level) => {
    const start = Math.floor(startSec * SAMPLE_RATE);
    const len = Math.floor(lenSec * SAMPLE_RATE);
    for (let i = 0; i < len; i += 1) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 9);
      samples[start + i] += (sine(freq, t) + 0.25 * sine(freq * 2, t)) * env * level;
    }
  };
  tone(0, 0.3, 880, 0.45);
  tone(0.14, 0.4, 1174, 0.4);
  return samples;
}

const outDir = path.resolve(process.cwd(), 'src', 'assets', 'sounds');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'eat.wav'), wavFromSamples(makeEat()));
await writeFile(path.join(outDir, 'pet.wav'), wavFromSamples(makePet()));
await writeFile(path.join(outDir, 'notify.wav'), wavFromSamples(makeNotify()));
console.log(`sounds generated: ${outDir}`);
