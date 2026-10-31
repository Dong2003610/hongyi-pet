import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const next = process.argv[2];
if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(next || '')) throw new Error('Usage: node tools/prepare-version.mjs 1.1.1');
const pinFile = '.doubao-pet-builder.json';
const pins = JSON.parse(await readFile(pinFile, 'utf8'));
const files = ['package.json', 'package-lock.json', 'pet-spec.json', '../pet-spec.json'];
const records = [];
for (const file of files) {
  const bytes = await readFile(file), from = createHash('sha256').update(bytes).digest('hex');
  if (pins.criticalFileHashes[file] && pins.criticalFileHashes[file] !== from) throw new Error(`Unmigrated protected changes: ${file}`);
  records.push({ file, from, data: JSON.parse(bytes.toString('utf8')) });
}
const current = records[0].data.version;
const a = next.split('.').map(Number), b = current.split('.').map(Number);
if (!a.some((n, i) => n > b[i] && a.slice(0, i).every((v, j) => v === b[j]))) throw new Error('Release version must increase');
const migrationPath = `migrations/release-${next}.json`;
if (await access(migrationPath).then(() => true, () => false)) throw new Error('Release migration already exists');
const migration = { id: `release-${next}`, description: `Advance portable updater release from ${current} to ${next}`, templateContractVersion: 5, specSchemaVersion: 5, files: [], validation: ['preflight.mjs', 'TypeScript noEmit', 'unit and updater helper tests', 'prepare-update-release.mjs validates build version and checksum'] };
for (const entry of records) {
  if (entry.file.endsWith('pet-spec.json')) entry.data.app.version = next;
  else { entry.data.version = next; if (entry.data.packages?.['']) entry.data.packages[''].version = next; }
  const bytes = JSON.stringify(entry.data, null, 2) + '\n';
  const to = createHash('sha256').update(bytes).digest('hex');
  if (pins.criticalFileHashes[entry.file]) { migration.files.push({ file: entry.file, from: entry.from, to }); pins.criticalFileHashes[entry.file] = to; }
  await writeFile(entry.file, bytes);
}
await writeFile(migrationPath, JSON.stringify(migration, null, 2) + '\n');
await writeFile(pinFile, JSON.stringify(pins, null, 2) + '\n');
console.log(`Release version prepared: ${current} -> ${next}`);
