import { execFile, spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdateRelease } from './update-feed';
import { UPDATE_HELPER } from './update-helper';
import { atomicWriteJson } from './persistence';

const execute = promisify(execFile);
export class PortableUpdate {
  constructor(private options: { executable: string; userData: string; forbidden: string[]; oldPid: number; version: string }) {}
  private job(id: string): string { if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('更新编号无效'); return path.join(this.options.userData, 'updates', id); }
  async prepare(archive: string, release: UpdateRelease, id: string): Promise<void> {
    const target = path.dirname(path.resolve(this.options.executable)); const parent = path.dirname(target);
    if (parent === target || this.options.forbidden.some(dir => path.resolve(dir).toLowerCase() === target.toLowerCase())
      || path.resolve(this.options.userData).toLowerCase().startsWith(target.toLowerCase() + path.sep)) throw new Error('请先将便携版放入独立文件夹，再进行一键更新');
    const info = await lstat(target); if (info.isSymbolicLink()) throw new Error('不支持在符号链接目录中替换程序');
    for (const name of ['resources/app.asar', 'chrome_100_percent.pak', 'icudtl.dat']) await access(path.join(target, name));
    const work = path.join(parent, `.hongyi-update-${id}`); const job = this.job(id);
    await mkdir(job, { recursive: true });
    try { await mkdir(work); } catch { throw new Error('程序目录没有更新写入权限，请将便携版移至可写的独立文件夹'); }
    await writeFile(path.join(job, 'helper.ps1'), '\ufeff' + UPDATE_HELPER, 'utf8');
    await atomicWriteJson(path.join(job, 'plan.json'), { id, target, work, archive, exe: path.basename(this.options.executable),
      size: release.size, sha256: release.sha256, version: release.version, oldPid: this.options.oldPid });
    try { await execute(this.powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(job, 'helper.ps1'), '-PlanPath', path.join(job, 'plan.json'), '-Mode', 'prepare'], { windowsHide: true, timeout: 120000, maxBuffer: 100000, cwd: job, env: this.environment() }); }
    catch { throw new Error('更新包解压校验失败，当前版本未改变；可重试下载'); }
  }
  async launch(id: string): Promise<void> {
    const job = this.job(id); await access(path.join(job, 'plan.json'));
    await rm(path.join(job, 'helper-ready.json'), { force: true });
    const child = spawn(this.powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(job, 'helper.ps1'), '-PlanPath', path.join(job, 'plan.json'), '-Mode', 'install'], { windowsHide: true, detached: true, stdio: 'ignore', cwd: job, env: this.environment() });
    let failed = false; child.on('error', () => { failed = true; }); child.on('exit', () => { failed = true; }); child.unref();
    for (let i = 0; i < 60; i++) {
      if (failed) break;
      try { const ready = JSON.parse((await readFile(path.join(job, 'helper-ready.json'), 'utf8')).replace(/^\ufeff/, '')); if (ready.id === id) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child.pid && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    throw new Error('更新助手未能启动，当前版本继续运行');
  }
  async previousFailure(): Promise<string | undefined> {
    const root = path.join(this.options.userData, 'updates');
    try {
      const results = await Promise.all((await readdir(root)).filter(id => /^[a-f0-9]{32}$/.test(id)).slice(-50).map(async id => {
        try { const raw = (await readFile(path.join(root, id, 'result.json'), 'utf8')).replace(/^\ufeff/, ''); return { id, raw: JSON.parse(raw), date: (await lstat(path.join(root, id, 'result.json'))).mtimeMs }; } catch { return undefined; }
      }));
      const latest = results.filter((value): value is NonNullable<typeof value> => Boolean(value)).sort((a, b) => b.date - a.date)[0];
      if (latest?.raw.status === 'rolled-back') return '上次更新未能完成启动检查，已经恢复原来的版本。可重新检查更新。';
      if (latest?.raw.status === 'recovery-needed') return `上次更新需要恢复：请查看 ${path.join(root, latest.id, 'result.json')}，原程序备份已保留。`;
    } catch { /* No prior jobs. */ }
  }
  async confirm(token: string | undefined): Promise<void> {
    if (!token || !/^[a-f0-9]{32}$/.test(token)) return;
    const job = this.job(token);
    const plan = JSON.parse(await readFile(path.join(job, 'plan.json'), 'utf8'));
    if (plan.id !== token || plan.version !== this.options.version || path.resolve(plan.target, plan.exe).toLowerCase() !== path.resolve(this.options.executable).toLowerCase()) throw new Error('更新启动信息不匹配');
    await atomicWriteJson(path.join(job, 'healthy.json'), { id: token, version: this.options.version });
  }
  private powershell(): string { return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
  private environment(): NodeJS.ProcessEnv { return { ...process.env, PSModulePath: path.join(path.dirname(this.powershell()), 'Modules') }; }
  async discard(id: string): Promise<void> {
    this.job(id);
    const parent = path.dirname(path.dirname(path.resolve(this.options.executable)));
    const work = path.join(parent, `.hongyi-update-${id}`);
    if (path.dirname(work) !== parent || path.basename(work) !== `.hongyi-update-${id}`) throw new Error('更新清理路径无效');
    await rm(work, { recursive: true, force: true });
  }
}
