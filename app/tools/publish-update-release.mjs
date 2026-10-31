// Publish only the locally verified, versioned portable assets. Credentials stay
// in this maintainer process; they are never written to or shipped with the pet.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.argv[2] || 'release');
const apply = process.argv.includes('--apply');
const repository = 'Dong2003610/hongyi-pet';
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifestBytes = await fs.readFile(path.join(directory, 'update-manifest.json'));
const manifest = JSON.parse(manifestBytes);
const name = `hongyi-pet-win32-x64-v${pkg.version}.zip`;
if (manifest.schema !== 1 || manifest.version !== pkg.version || manifest.windows?.name !== name) throw new Error('Release package version mismatch');
const archive = await fs.readFile(path.join(directory, name));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (manifest.windows.size !== archive.length || manifest.windows.sha256 !== digest(archive)) throw new Error('Release package checksum mismatch');
const lookup = spawnSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
  cwd: root, input: `protocol=https\nhost=github.com\npath=${repository}.git\n\n`, encoding: 'utf8', windowsHide: true,
  env: { ...process.env, GCM_INTERACTIVE: 'Never', GIT_TERMINAL_PROMPT: '0' }, timeout: 20000,
});
const token = lookup.status === 0 && lookup.stdout.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
if (!token) throw new Error('GitHub stored authorization unavailable');
async function request(endpoint, method = 'GET', body, allowed404 = false) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  if (allowed404 && response.status === 404) return undefined;
  const result = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${result.message || 'request failed'}`);
  return result;
}
const tag = `v${pkg.version}`;
const head = (await request('git/ref/heads/main')).object.sha;
let release = await request(`releases/tags/${tag}`, 'GET', undefined, true);
console.log(JSON.stringify({ apply, tag, head, bytes: archive.length, sha256: digest(archive), existing: release ? { id: release.id, draft: release.draft } : null }));
if (!apply) process.exit(0);
const verified = JSON.parse(await fs.readFile(path.join(root, '.build/contents-publish/verified.json'), 'utf8'));
if (!verified.verified || verified.repository !== repository || verified.commit !== head || process.env.EXPECTED_HEAD !== head) throw new Error('Publish source through Contents API and review EXPECTED_HEAD before release');
const existingTag = await request(`git/ref/tags/${tag}`, 'GET', undefined, true);
if (existingTag && (existingTag.object.type !== 'commit' || existingTag.object.sha !== head)) throw new Error('Existing version tag does not match verified source');
if (release && !release.draft) throw new Error('Published versions are immutable; increase version for a new release');
if (release && release.target_commitish !== head) throw new Error('Draft belongs to a different source revision');
if (!release) release = await request('releases', 'POST', { tag_name: tag, target_commitish: head, name: `小红桌宠 ${pkg.version}`, body: manifest.notes, draft: true, prerelease: false });
const assets = [{ name, bytes: archive, type: 'application/zip' }, { name: 'update-manifest.json', bytes: manifestBytes, type: 'application/json' }];
for (const asset of assets) {
  const present = (await request(`releases/${release.id}/assets`)).find(value => value.name === asset.name);
  if (present) {
    if (present.size !== asset.bytes.length || present.digest !== `sha256:${digest(asset.bytes)}`) throw new Error('Existing draft asset differs; inspect draft before retrying');
    continue;
  }
  const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': asset.type, 'Content-Length': String(asset.bytes.length), 'X-GitHub-Api-Version': '2022-11-28' },
    body: asset.bytes, signal: AbortSignal.timeout(300000),
  });
  const uploaded = await response.json();
  if (!response.ok || uploaded.size !== asset.bytes.length || uploaded.digest !== `sha256:${digest(asset.bytes)}`) throw new Error(`Asset upload failed verification: ${asset.name} (HTTP ${response.status})`);
  console.log(`Verified uploaded asset: ${asset.name}`);
}
if ((await request('git/ref/heads/main')).object.sha !== head) throw new Error('Source changed during upload; draft retained for review');
await request(`releases/${release.id}`, 'PATCH', { draft: false, make_latest: 'true' });
const latest = await request('releases/latest');
if (latest.id !== release.id || latest.tag_name !== tag || latest.draft) throw new Error('Latest release verification failed');
const audit = path.join(root, '.build/update-release-publish'); await fs.mkdir(audit, { recursive: true });
await fs.writeFile(path.join(audit, 'verified.json'), JSON.stringify({ repository, commit: head, tag, release: latest.html_url, sha256: digest(archive), bytes: archive.length, verified: true }, null, 2) + '\n');
console.log(`Published verified update: ${latest.html_url}`);
