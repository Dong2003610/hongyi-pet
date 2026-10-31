// Real Windows directory swap/rollback using tiny local fixture executables.
// Never launches, replaces or reads the user's real desktop pet/profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const ts = require('typescript');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const execute = promisify(execFile);
const run = (command, args, options = {}) => execute(command, args, { ...options, env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), 'Modules') } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.equal(process.platform, 'win32');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-update-helper-'));
  const module = { exports: {} };
  const compiled = ts.transpileModule(await fs.readFile(path.resolve('src/main/update-helper.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('exports', compiled)(module.exports);
  try {
    const source = path.join(root, 'Fixture.cs'), binary = path.join(root, 'pet.exe');
    await fs.writeFile(source, `using System; using System.IO; using System.Threading;
      class Fixture { static void Main(string[] args) {
        string root=AppDomain.CurrentDomain.BaseDirectory;
        File.WriteAllText(Path.Combine(root,"booted.txt"),"started");
        string[] lines=File.ReadAllLines(Path.Combine(root,"behavior.txt"));
        if(lines[0]=="healthy") File.WriteAllText(lines[1],lines[2]);
        if(Array.IndexOf(args,"--hold")>=0) Thread.Sleep(60000);
      } }`);
    const compile = path.join(root, 'compile.ps1');
    await fs.writeFile(compile, 'param($Source,$Output)\n$ErrorActionPreference="Stop"\nAdd-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -OutputAssembly $Output -OutputType ConsoleApplication\n');
    await run(powershell, ['-NoProfile', '-NonInteractive', '-File', compile, '-Source', source, '-Output', binary], { windowsHide: true });
    for (const scenario of ['healthy', 'failed']) {
      const id = randomBytes(16).toString('hex');
      const base = path.join(root, `更新's $test [${scenario}]`), target = path.join(base, 'portable'), work = path.join(base, `.hongyi-update-${id}`), job = path.join(base, 'profile/updates', id);
      const packageRoot = path.join(base, 'package'); await fs.mkdir(target, { recursive: true }); await fs.mkdir(work); await fs.mkdir(job, { recursive: true });
      await fs.copyFile(binary, path.join(target, 'pet.exe')); await fs.writeFile(path.join(target, 'behavior.txt'), 'old'); await fs.writeFile(path.join(target, 'old-only.txt'), 'old');
      const userSettings = path.join(base, 'profile/settings.json'); await fs.writeFile(userSettings, '{"keep":"account-and-key-placeholder"}');
      await fs.mkdir(path.join(packageRoot, 'resources'), { recursive: true }); await fs.copyFile(binary, path.join(packageRoot, 'pet.exe'));
      for (const file of ['resources/app.asar', 'chrome_100_percent.pak', 'icudtl.dat']) await fs.writeFile(path.join(packageRoot, file), 'fixture');
      await fs.writeFile(path.join(packageRoot, 'behavior.txt'), `${scenario}\n${path.join(job, 'healthy.json')}\n${JSON.stringify({ id, version: '1.2.0' })}`);
      const archive = path.join(job, 'update.zip'); const zipScript = path.join(root, 'zip.ps1');
      await fs.writeFile(zipScript, 'param($Source,$Output)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Output)\n');
      await run(powershell, ['-NoProfile', '-NonInteractive', '-File', zipScript, '-Source', packageRoot, '-Output', archive], { windowsHide: true });
      const bytes = await fs.readFile(archive), old = spawn(path.join(target, 'pet.exe'), ['--hold'], { windowsHide: true, cwd: root, stdio: 'ignore' });
      const helper = path.join(job, 'helper.ps1'), plan = path.join(job, 'plan.json');
      await fs.writeFile(helper, '\ufeff' + module.exports.UPDATE_HELPER);
      await fs.writeFile(plan, JSON.stringify({ id, target, work, archive, exe: 'pet.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: '1.2.0', oldPid: old.pid }));
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanPath', plan];
      try {
        await run(powershell, [...args, '-Mode', 'prepare'], { windowsHide: true, cwd: root, timeout: 30000 });
        assert.equal(await fs.readFile(path.join(target, 'old-only.txt'), 'utf8'), 'old', 'preparation does not replace old app');
        let helperResult;
        const installing = run(powershell, [...args, '-Mode', 'install', '-HealthSeconds', '2'], { windowsHide: true, cwd: root, timeout: 40000 }).then(() => { helperResult = 0; }, error => { helperResult = error.code; });
        for (let i = 0; i < 100; i++) { if (await fs.access(path.join(job, 'helper-ready.json')).then(() => true, () => false)) break; await sleep(50); }
        assert.equal(await fs.readFile(path.join(target, 'old-only.txt'), 'utf8'), 'old', 'old files remain while old process is running');
        old.kill(); await installing;
        const receipt = JSON.parse((await fs.readFile(path.join(job, 'result.json'), 'utf8')).replace(/^\ufeff/, ''));
        assert.equal(receipt.status, scenario === 'healthy' ? 'installed' : 'rolled-back', JSON.stringify(receipt));
        assert.equal(helperResult, scenario === 'healthy' ? 0 : 1);
        assert.equal(await fs.readFile(userSettings, 'utf8'), '{"keep":"account-and-key-placeholder"}', 'profile is preserved');
        if (scenario === 'healthy') {
          assert.equal(await fs.access(path.join(target, 'old-only.txt')).then(() => true, () => false), false, 'obsolete program files are removed by directory replacement');
          assert.equal(await fs.readFile(path.join(base, `.hongyi-backup-${id}`, 'old-only.txt'), 'utf8'), 'old', 'old release backup is recoverable');
        } else assert.equal(await fs.readFile(path.join(target, 'old-only.txt'), 'utf8'), 'old', 'failed startup restores the old complete folder');
      } finally { if (old.exitCode === null) old.kill(); }
    }
    // Zip-slip rejection uses a real .NET-created malicious ZIP.
    const id = randomBytes(16).toString('hex'), base = path.join(root, 'malicious'), job = path.join(base, 'profile/updates', id), work = path.join(base, `.hongyi-update-${id}`);
    await fs.mkdir(job, { recursive: true }); await fs.mkdir(work); const archive = path.join(job, 'update.zip');
    const maliciousScript = path.join(root, 'malicious.ps1');
    await fs.writeFile(maliciousScript, `param($Output)\n$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip=[IO.Compression.ZipFile]::Open($Output,'Create')\ntry{$zip.CreateEntry('../escape.txt') | Out-Null}finally{$zip.Dispose()}\n`);
    await run(powershell, ['-NoProfile', '-File', maliciousScript, '-Output', archive], { windowsHide: true });
    const bytes = await fs.readFile(archive); const helper = path.join(job, 'helper.ps1'), plan = path.join(job, 'plan.json');
    await fs.writeFile(helper, '\ufeff' + module.exports.UPDATE_HELPER);
    await fs.writeFile(plan, JSON.stringify({ id, target: path.join(base, 'portable'), work, archive, exe: 'pet.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    await assert.rejects(run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-PlanPath', plan, '-Mode', 'prepare'], { windowsHide: true }));
    assert.equal(await fs.access(path.join(work, 'escape.txt')).then(() => true, () => false), false);
    console.log('Windows update helper: PASS (verified prepare, wait for old process, directory swap, health handshake, automatic rollback, preserved profile, unicode/special paths, zip-slip rejection; local fixture executables only).');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
