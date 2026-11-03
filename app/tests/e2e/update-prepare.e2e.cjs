// Exercise the adapter inside Electron: Node-only tests miss patched ASAR fs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const asar = require('@electron/asar');
const ts = require('typescript');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-electron-prepare-'));
  try {
    for (const name of ['portable-update', 'update-helper', 'persistence']) {
      const source = await fs.readFile(`src/main/${name}.ts`, 'utf8');
      await fs.writeFile(path.join(root, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
    }
    const content = path.join(root, 'asar-content'), portable = path.join(root, '中文桌宠'), resources = path.join(portable, 'resources');
    await fs.mkdir(content); await fs.mkdir(resources, { recursive: true });
    await fs.writeFile(path.join(content, 'package.json'), JSON.stringify({ name: 'update-fixture', version: '1.0.0' }));
    await asar.createPackage(content, path.join(resources, 'app.asar'));
    for (const name of ['pet.exe', 'chrome_100_percent.pak', 'icudtl.dat']) await fs.writeFile(path.join(portable, name), 'fixture');
    const archive = path.join(root, 'update.zip'), zipScript = path.join(root, 'zip.ps1');
    await fs.writeFile(zipScript, "param($Source,$Output)\n$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Output)\n");
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', zipScript, '-Source', portable, '-Output', archive], { windowsHide: true, env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), 'Modules') } });
    const bytes = await fs.readFile(archive);
    await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify({ root, portable, archive, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    const script = path.join(root, 'main.cjs');
    await fs.writeFile(script, `const {app}=require('electron'),fs=require('node:fs/promises'),disk=require('original-fs').promises,path=require('path'),assert=require('node:assert/strict'),{PortableUpdate}=require('./portable-update'),fixture=require('./fixture.json');
      app.setPath('userData',path.join(fixture.root,'electron-profile'));
      app.whenReady().then(async()=>{let code=0;const id='a'.repeat(32);const adapter=new PortableUpdate({executable:path.join(fixture.portable,'pet.exe'),userData:path.join(fixture.root,'profile'),forbidden:[],oldPid:process.pid,version:'1.0.0'});try{
        const archiveFile=path.join(fixture.portable,'resources/app.asar');
        assert.ok((await disk.stat(archiveFile)).isFile());
        await assert.rejects(fs.access(archiveFile),/ENOENT/,'reproduce original Electron ASAR virtual lookup failure');
        const before=await disk.readFile(archiveFile);
        await adapter.prepare(fixture.archive,{version:'1.1.0',size:fixture.size,sha256:fixture.sha256},id);
        const result=JSON.parse((await fs.readFile(path.join(fixture.root,'profile/updates',id,'result.json'),'utf8')).replace(/^\\ufeff/,''));
        assert.equal(result.status,'prepared');assert.deepEqual(await disk.readFile(archiveFile),before,'preparation leaves current app intact');
        assert.ok((await disk.stat(path.join(fixture.root,'.hongyi-update-'+id,'new/resources/app.asar'))).isFile());
        await adapter.discard(id);
        const missing=path.join(fixture.root,'missing-portable');await disk.mkdir(missing);
        const broken=new PortableUpdate({executable:path.join(missing,'pet.exe'),userData:path.join(fixture.root,'profile'),forbidden:[],oldPid:process.pid,version:'1.0.0'});
        await assert.rejects(broken.prepare(fixture.archive,{version:'1.1.0',size:fixture.size,sha256:fixture.sha256},'b'.repeat(32)),/resources\\/app.asar/,'genuinely missing package fails clearly');
        console.log('Electron update prepare: PASS (reproduced ASAR ENOENT, native-file check, real helper extraction, current app preserved, missing-file failure).');
      }catch(e){console.error(e);code=1;}finally{await adapter.discard(id).catch(()=>{});app.exit(code);}});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [script], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const timeout = setTimeout(() => child.kill(), 140000);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); clearTimeout(timeout);
    assert.equal(code, 0, output); console.log(output.trim());
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
