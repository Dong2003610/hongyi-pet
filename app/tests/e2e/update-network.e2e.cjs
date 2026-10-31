// Real Chromium HTTP transport, entirely against a local disposable server.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const ts = require('typescript');
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-update-network-'));
  try {
    const compiled = ts.transpileModule(await fs.readFile('src/main/update-network.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    await fs.writeFile(path.join(directory, 'transport.js'), compiled);
    const script = path.join(directory, 'main.cjs');
    await fs.writeFile(script, `const {app}=require('electron'),http=require('node:http'),assert=require('node:assert/strict'),{updateFetch}=require('./transport');
      app.whenReady().then(async()=>{let server,code=0,hits=0;try {
        console.log('network:ready');
        server=http.createServer((req,res)=>{hits++;if(req.url==='/redirect'){res.writeHead(302,{location:'/file'});res.end();}else if(req.url==='/slow'){res.writeHead(200,{'content-type':'application/octet-stream'});res.write(Buffer.alloc(65536));}else{res.writeHead(200);res.write('hello');setTimeout(()=>res.end(' world'),20);}});
        await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
        let r=await updateFetch(base+'/redirect',{signal:AbortSignal.timeout(5000)});assert.equal(r.status,302);assert.equal(r.headers.get('location'),base+'/file');assert.equal(hits,1,'adapter must not follow redirect before allowlist validation');console.log('network:redirect');
        r=await updateFetch(base+'/file',{signal:AbortSignal.timeout(5000)});assert.equal(await r.text(),'hello world');console.log('network:stream');
        const cancel=new AbortController();r=await updateFetch(base+'/slow',{signal:cancel.signal});const reader=r.body.getReader();await reader.read();console.log('network:before-cancel');cancel.abort();await assert.rejects(reader.read());console.log('network:cancel');
        const before=new AbortController();before.abort();await assert.rejects(updateFetch(base+'/file',{signal:before.signal}));
        console.log('Update system network: PASS (manual redirects, streaming body, cancellation before/after response; local server only).');
      }catch(e){console.error(e);code=1;}finally{server?.closeAllConnections();server?.close();app.exit(code);}});`);
    const env = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [script], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const timeout = setTimeout(() => child.kill(), 20000);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); }); clearTimeout(timeout);
    assert.equal(code, 0, output); console.log(output.trim());
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
