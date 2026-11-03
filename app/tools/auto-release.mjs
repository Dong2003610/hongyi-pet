import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const parts = value => {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) throw new Error(`Invalid stable version: ${value}`);
  return value.split('.').map(Number);
};
export function compareVersions(a, b) {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
export function nextReleaseVersion(current, releases) {
  parts(current);
  const latest = releases.reduce((best, value) => compareVersions(value, best) > 0 ? value : best, '0.0.0');
  if (compareVersions(current, latest) > 0) return current;
  const version = parts(latest); version[2]++;
  const next = version.join('.'); parts(next); return next;
}
export function canPublish(source, remote) {
  if (!/^[a-f0-9]{40}$/.test(source) || !/^[a-f0-9]{40}$/.test(remote)) throw new Error('Invalid source revision');
  return source === remote;
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${executable} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const git = (...args) => command('git', args);
async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing Actions output file');
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
async function api(endpoint, allow404 = false) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30000),
  });
  if (allow404 && response.status === 404) return undefined;
  const result = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${result.message || 'request failed'}`);
  return result;
}
async function prepare() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const published = [];
  // Include all published stable versions, even when a maintainer changes Latest.
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Too many releases; review version selection');
    const releases = await api(`releases?per_page=100&page=${page}`);
    for (const release of releases) {
      if (!release.draft && !release.prerelease && /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(release.tag_name)) published.push(release.tag_name.slice(1));
    }
    if (releases.length < 100) break;
  }
  const version = nextReleaseVersion(pkg.version, published);
  if (version !== pkg.version) command(process.execPath, [fileURLToPath(new URL('./prepare-version.mjs', import.meta.url)), version]);
  const latest = published.sort(compareVersions).at(-1);
  const messages = latest ? git('log', `v${latest}..HEAD`, '--format=%s', '--max-count=20').split('\n') : [];
  const notes = messages.filter(value => value && !value.startsWith('chore(release):')).map(value => `- ${value.replace(/[\r\n]/g, ' ')}`);
  await writeFile('RELEASE_NOTES.md', `小红桌宠 ${version}\n\n${notes.join('\n') || '- 更新桌宠功能与使用体验。'}\n\n本版本已通过自动测试和便携版构建，支持在小屋设置中下载并重启更新。\n`);
  await output('version', version);
  console.log(`Prepared automatic release v${version}`);
}
async function finalize() {
  const version = JSON.parse(await readFile('package.json', 'utf8')).version; parts(version);
  const tag = `v${version}`;
  const source = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
  // A newer main must publish its own complete checkout. Never rewrite its files.
  if (!canPublish(source, remote)) {
    console.log('Main advanced during build; a newer queued run will publish it.');
    await output('publish', 'false'); return;
  }
  const release = await api(`releases/tags/${tag}`, true);
  if (release && !release.draft) throw new Error(`Version ${tag} was already published; do not replace its assets`);
  const files = ['package.json', 'package-lock.json', 'pet-spec.json', '../pet-spec.json', '.doubao-pet-builder.json', 'RELEASE_NOTES.md'];
  const migration = `migrations/release-${version}.json`;
  if (await access(migration).then(() => true, () => false)) files.push(migration);
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('add', '--', ...files);
  const staged = git('diff', '--cached', '--name-only');
  if (staged) git('commit', '-m', `chore(release): ${tag} [skip ci]`);
  const head = git('rev-parse', 'HEAD');
  const existing = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).split(/\s/)[0];
  if (existing && existing !== head) throw new Error(`Tag ${tag} already points to another source revision`);
  if (!existing) git('tag', tag);
  // Single atomic fast-forward: never create a tag if main changed while building.
  git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`);
  await output('publish', 'true'); await output('version', version);
  console.log(`Verified source/tag pushed: ${tag} (${head})`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'Dong2003610/hongyi-pet' || process.env.GITHUB_REF !== 'refs/heads/main' || !process.env.GH_TOKEN) throw new Error('Automatic release is restricted to this repository main Actions checkout');
  if (process.argv[2] === 'prepare') await prepare();
  else if (process.argv[2] === 'finalize') await finalize();
  else throw new Error('Usage: node tools/auto-release.mjs prepare|finalize');
}
