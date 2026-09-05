import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const inputDir = path.resolve('incoming-assets');
const outputDir = path.resolve('src', 'assets', 'pet');
const trayDir = path.resolve('src', 'assets', 'tray');
const specPath = path.resolve('pet-spec.json');
const spec = JSON.parse(await readFile(specPath, 'utf8'));

await mkdir(outputDir, { recursive: true });
await mkdir(trayDir, { recursive: true });

const reports = [];
const failures = [];
const names = new Set(spec.states.flatMap((state) => state.frames));
names.add(spec.character.coreAsset);

const safeMargin = 24;
const targetOccupancy = 0.78;
const maximum = Math.min(512 - safeMargin * 2, Math.floor(512 * targetOccupancy));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 使用 sharp.trim() 来自动检测并裁剪到主体
// trim 会找到最大的非透明/非背景区域
async function processImage(name) {
  const source = path.join(inputDir, name);
  
  try {
    // 使用 trim 自动裁剪到主体
    const trimmed = await sharp(source)
      .trim({ threshold: 30, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    
    const { data, info } = trimmed;
    const { width, height } = info;
    
    // 如果 trim 失败（返回原尺寸），使用完整图像
    if (width === 2048 && height === 2048) {
      console.warn(`  ${name}: trim failed, using full image`);
    }
    
    return {
      name,
      data,
      width,
      height,
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
      cropWidth: width,
      cropHeight: height,
      foregroundRatio: 1.0,
    };
  } catch (error) {
    // 如果 trim 失败，读取原图
    const original = await sharp(source)
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    
    const { data, info } = original;
    const { width, height } = info;
    
    return {
      name,
      data,
      width,
      height,
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
      cropWidth: width,
      cropHeight: height,
      foregroundRatio: 1.0,
    };
  }
}

console.log('Processing assets...');

const extracted = new Map();
for (const name of names) {
  try {
    extracted.set(name, await processImage(name));
    process.stdout.write('.');
  } catch (error) {
    failures.push({ ok: false, name, message: error.message });
    process.stdout.write('x');
  }
}
console.log(`\nExtracted ${extracted.size}/${names.size} assets`);

if (!failures.length) {
  for (const state of spec.states) {
    const stateAssets = state.frames.map((frame) => extracted.get(frame));
    if (stateAssets.some((a) => !a)) {
      failures.push({ ok: false, name: state.id, message: 'missing frame' });
      continue;
    }
    
    const groupWidth = Math.max(...stateAssets.map((a) => a.cropWidth));
    const groupHeight = Math.max(...stateAssets.map((a) => a.cropHeight));
    const sharedScale = Math.min(maximum / groupWidth, maximum / groupHeight, 1);
    
    const prepared = [];
    for (const asset of stateAssets) {
      const w = Math.max(1, Math.round(asset.cropWidth * sharedScale));
      const h = Math.max(1, Math.round(asset.cropHeight * sharedScale));
      
      const initial = await sharp(asset.data, { raw: { width: asset.width, height: asset.height, channels: 4 } })
        .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer();
      
      const meta = await sharp(initial).metadata();
      prepared.push({ asset, visible: initial, bounds: { width: meta.width, height: meta.height } });
    }
    
    const refW = median(prepared.map((p) => p.bounds.width));
    const refH = median(prepared.map((p) => p.bounds.height));
    
    for (const item of prepared) {
      const { asset } = item;
      const correction = Math.sqrt((refW * refH) / (item.bounds.width * item.bounds.height));
      const cw = Math.max(1, Math.round(item.bounds.width * correction));
      const ch = Math.max(1, Math.round(item.bounds.height * correction));
      
      const occScale = Math.min(1, maximum / cw, maximum / ch);
      const bw = Math.max(1, Math.round(cw * occScale));
      const bh = Math.max(1, Math.round(ch * occScale));
      
      const corrected = await sharp(item.visible)
        .resize(bw, bh, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png().toBuffer();
      
      const cMeta = await sharp(corrected).metadata();
      const cropped = await sharp(corrected).extract({
        left: 0, top: 0, width: cMeta.width, height: cMeta.height,
      }).png().toBuffer();
      
      const anchorX = Math.round(state.anchor.x * 511);
      const anchorY = Math.round(state.anchor.y * 511);
      const left = Math.round(anchorX - cMeta.width / 2);
      const top = Math.round(anchorY - cMeta.height);
      
      const destination = path.join(outputDir, asset.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: cropped, left: Math.max(0, left), top: Math.max(0, top) }])
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(destination);
      
      reports.push({ ok: true, name: asset.name, state: state.id });
      process.stdout.write('.');
    }
  }
}

// Process core IP
if (!failures.length) {
  const asset = extracted.get(spec.character.coreAsset);
  if (asset) {
    const sharedScale = Math.min(maximum / asset.cropWidth, maximum / asset.cropHeight, 1);
    const w = Math.max(1, Math.round(asset.cropWidth * sharedScale));
    const h = Math.max(1, Math.round(asset.cropHeight * sharedScale));
    
    const visible = await sharp(asset.data, { raw: { width: asset.width, height: asset.height, channels: 4 } })
      .resize(w, h, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .png().toBuffer();
    
    const meta = await sharp(visible).metadata();
    const left = Math.round(256 - meta.width / 2);
    const top = Math.round(0.95 * 511 - meta.height);
    
    const destination = path.join(outputDir, spec.character.coreAsset);
    await mkdir(path.dirname(destination), { recursive: true });
    await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: visible, left: Math.max(0, left), top: Math.max(0, top) }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(destination);
    
    const trayPath = path.join(trayDir, 'tray-icon.png');
    const trimmed = await sharp(destination).trim({ threshold: 8 }).resize(28, 28, { fit: 'contain', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: trimmed, left: 2, top: 2 }]).png({ compressionLevel: 9 }).toFile(trayPath);
    
    reports.push({ ok: true, name: spec.character.coreAsset, state: 'core-ip' });
  }
}

console.log(`\nProcessed ${reports.length}/${names.size} assets`);
if (failures.length) {
  for (const f of failures) console.error(`[ERROR] ${f.name}: ${f.message}`);
  process.exit(1);
}

const reportPath = path.join(outputDir, 'asset-processing-report.json');
await writeFile(reportPath, JSON.stringify({ reports, failures }, null, 2));
console.log(`Report: ${reportPath}`);
