// Real Electron bubble windows, hidden with zero opacity and an isolated profile.
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { _electron } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-surfaces-'));
  let application;
  try {
    const compiler = webpack({ mode: 'development', context: root, target: 'electron-main',
      entry: path.join(root, 'src/main/pet-bubble.ts'),
      output: { path: directory, filename: 'bubble.cjs', library: { type: 'commonjs2' } },
      module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }] },
      resolve: { extensions: ['.ts', '.js'] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
    const entry = path.join(directory, 'electron.cjs');
    await writeFile(entry, `const { app, BrowserWindow } = require('electron');
      const { PetBubble } = require('./bubble.cjs');
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
      app.whenReady().then(() => {
        global.pet = new BrowserWindow({ x:400, y:450, width:110, height:110, frame:false, show:false, opacity:0,
          webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false } });
        global.bubble = new PetBubble(() => pet, true);
        pet.on('move', () => bubble.reposition()); pet.on('resize', () => bubble.reposition()); pet.on('hide', () => bubble.hide());
        pet.loadURL('about:blank').then(() => pet.showInactive());
      });`);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [entry], env: environment });
    await application.firstWindow();
    const snapshot = () => application.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((window) => window !== global.pet);
      return { pet: global.pet.getBounds(), bubble: win?.getBounds(), visible: win?.isVisible(), focusable: win?.isFocusable(),
        content: win ? await win.webContents.executeJavaScript(`({font: getComputedStyle(document.querySelector('p')).fontSize, background: getComputedStyle(document.querySelector('p')).backgroundColor, text: document.querySelector('p').textContent, maliciousNodes: document.querySelectorAll('script,img').length, height: document.querySelector('p').getBoundingClientRect().height})`) : null };
    });
    await application.evaluate(async () => { global.pet.showInactive(); await global.bubble.show('咔嚓！今天也一起加油。'); });
    const small = await snapshot();
    assert.equal(small.visible, true); assert.equal(small.focusable, false);
    assert.equal(small.content.font, '14px'); assert.ok(small.bubble.y + small.bubble.height < small.pet.y);
    assert.equal(small.bubble.width, 280); assert.equal(small.content.background, 'rgba(255, 253, 249, 0.8)');
    assert.equal(small.pet.y - small.bubble.y - small.bubble.height, 2);
    await application.evaluate(async () => { global.pet.setSize(330, 330); await global.bubble.show('<img src=x onerror=alert(1)>' + '你'.repeat(200)); });
    const large = await snapshot();
    assert.equal(large.content.font, small.content.font, 'bubble font never scales with the pet');
    assert.equal(large.content.maliciousNodes, 0); assert.ok(large.content.height <= 126);
    assert.ok(large.bubble.y + large.bubble.height < large.pet.y);
    await application.evaluate(async () => { global.pet.setPosition(100, 0); await global.bubble.show('贴顶时移到身旁，头部保持无遮挡'); });
    const edge = await snapshot();
    assert.ok(edge.bubble.x >= edge.pet.x + edge.pet.width || edge.bubble.x + edge.bubble.width <= edge.pet.x);
    await application.evaluate(() => global.pet.hide());
    assert.equal((await snapshot()).visible, false, 'hiding the pet also hides its bubble');
    await application.evaluate(async () => { await global.bubble.show('隐藏时不出现'); });
    assert.equal((await snapshot()).visible, false);
    await application.evaluate(async () => { global.pet.showInactive(); await global.bubble.show('重新显示'); });
    assert.equal((await snapshot()).visible, true);
    console.log('Pet surfaces: PASS (real independent transparent window, fixed 14px type at small/large scales, above-head/edge placement, literal text, hide/show).');
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
