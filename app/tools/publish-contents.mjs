// Publish reviewed workspace changes through GitHub Contents API. Credentials
// remain in memory; unrelated remote paths and concurrent edits are preserved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'Dong2003610/hongyi-pet';
const apply = process.argv.includes('--apply');
function git(args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GCM_INTERACTIVE: 'Never', GIT_TERMINAL_PROMPT: '0' }, timeout: 20000 });
  if (result.status !== 0) throw new Error('Git inspection or stored credential lookup failed');
  return result.stdout;
}
const credential = Object.fromEntries(git(['-c', 'credential.interactive=false', 'credential', 'fill'],
  `protocol=https\nhost=github.com\npath=${repository}.git\n\n`).split(/\r?\n/).filter(s => s.includes('='))
  .map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
if (!credential.password) throw new Error('GitHub authorization unavailable');
async function request(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    method, headers: { Authorization: `Bearer ${credential.password}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${result.message || 'request failed'}`);
  return result;
}
const localHead = git(['rev-parse', 'HEAD']).trim();
const remoteHead = (await request('git/ref/heads/main')).object.sha;
const base = new Map(git(['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean)
  .map(s => [s.slice(s.indexOf('\t') + 1), s.slice(0, s.indexOf('\t')).split(' ')[2]]));
const remoteTree = await request(`git/trees/${remoteHead}?recursive=1`);
if (remoteTree.truncated) throw new Error('Remote tree is incomplete');
const remote = new Map(remoteTree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
const candidates = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
const changes = [];
for (const name of candidates) {
  if (/(^|\/)(?:node_modules|\.git|\.build|\.webpack|release|out)(\/|$)/.test(name)) throw new Error(`Unexpected publishing path: ${name}`);
  if (/(^|\/)(?:\.env(?:\..+)?|ai-config\.json|chat-history\.json|task-list-session\.json)$/.test(name) && !name.endsWith('.example'))
    throw new Error(`Private configuration cannot be published: ${name}`);
  let bytes;
  try { bytes = await fs.readFile(path.join(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sha = bytes && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha === base.get(name) || sha === remote.get(name)) continue;
  if (remote.get(name) !== base.get(name)) throw new Error(`Concurrent remote edit requires review: ${name}`);
  changes.push({ path: name, before: remote.get(name), after: sha, bytes });
}
const audit = path.join(root, 'app/.build/contents-publish');
await fs.mkdir(audit, { recursive: true });
await fs.writeFile(path.join(audit, 'plan.json'), JSON.stringify({ localHead, remoteHead,
  changes: changes.map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes?.length ?? 0 })) }, null, 2));
console.log(JSON.stringify({ apply, localHead, remoteHead, changes: changes.length,
  bytes: changes.reduce((n, c) => n + (c.bytes?.length ?? 0), 0),
  paths: !apply ? changes.map(c => c.path) : undefined }, null, 2));
if (!apply || !changes.length) process.exit(0);
if (process.env.EXPECTED_HEAD !== remoteHead) throw new Error('Set EXPECTED_HEAD to the reviewed remote revision');
let expected = remoteHead;
const completed = [];
// Contents API commits one file at a time. Stage on a temporary branch so
// main and its build workflow see only the fully verified release.
const branch = `codex/sync-${Date.now()}`;
await request('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: remoteHead });
for (const [index, entry] of changes.entries()) {
  if ((await request(`git/ref/heads/${branch}`)).object.sha !== expected) throw new Error('Upload branch changed during publication');
  const endpoint = `contents/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
  const result = await request(endpoint, entry.bytes ? 'PUT' : 'DELETE', {
    message: `feat: companion interaction and motion update (${index + 1}/${changes.length}): ${entry.path}`,
    branch, ...(entry.before ? { sha: entry.before } : {}),
    ...(entry.bytes ? { content: entry.bytes.toString('base64') } : {}),
  });
  expected = result.commit.sha;
  completed.push({ path: entry.path, sha: entry.after, commit: expected });
  await fs.writeFile(path.join(audit, 'progress.json'), JSON.stringify({ previousHead: remoteHead, branch, head: expected, completed }, null, 2));
  console.log(`Uploaded ${index + 1}/${changes.length}: ${entry.path}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const finalTree = await request(`git/trees/${expected}?recursive=1`);
if (finalTree.truncated) throw new Error('Final tree is incomplete');
const final = new Map(finalTree.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
for (const c of changes) if (final.get(c.path) !== c.after) throw new Error(`Remote verification failed: ${c.path}`);
if ((await request('git/ref/heads/main')).object.sha !== remoteHead) throw new Error('Remote main changed; verified upload remains on the temporary branch');
await request('git/refs/heads/main', 'PATCH', { sha: expected, force: false });
if ((await request('git/ref/heads/main')).object.sha !== expected) throw new Error('Main verification failed');
await fs.writeFile(path.join(audit, 'verified.json'), JSON.stringify({ repository, previousHead: remoteHead,
  commit: expected, files: changes.length, verified: true, checkedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ verified: true, commit: expected, files: changes.length,
  url: `https://github.com/${repository}/commit/${expected}` }, null, 2));
