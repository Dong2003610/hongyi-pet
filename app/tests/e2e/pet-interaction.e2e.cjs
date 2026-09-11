// Compile the current renderer and exercise it in an isolated, hidden Electron
// window. All IPC and AI replies are mocked; no user profile or network is used.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const webpack = require('webpack');
const { _electron } = require('@playwright/test');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-pet-ui-'));
  let application;
  try {
    const config = require('../../webpack.renderer.config.js');
    const compiler = webpack({ ...config, mode: 'development', context: root, target: 'web',
      entry: path.join(root, 'src/renderer/pet/index.ts'),
      output: { path: directory, filename: 'pet.js', publicPath: '' },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
    const source = await readFile(path.join(root, 'src/renderer/pet/index.html'), 'utf8');
    const html = source.replace('</head>', '<link rel="stylesheet" href="main.css"></head>')
      .replace('</body>', '<script src="pet.js"></script></body>');
    const htmlFile = path.join(directory, 'index.html');
    await writeFile(htmlFile, html);
    const entry = path.join(directory, 'electron.cjs');
    await writeFile(entry, `const {app, BrowserWindow} = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
      app.whenReady().then(() => { global.win = new BrowserWindow({width:220,height:220,frame:false,show:false,
        webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
        win.loadURL('about:blank'); });`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [entry], env: environment });
    const page = await application.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.petAPI = {
        events: {
          onStateActivity: (callback) => { window.emitActivity = callback; }, onPlaySound: () => {},
        },
        window: { beginDrag: async () => {}, updateDrag: async () => {}, endDrag: async () => {}, showContextMenu: async () => {} },
        files: { getPathForFile: () => '', put: async () => ({ copied: [] }) },
        runtime: { ready: async () => { window.petReady = true; }, fail: async (error) => { throw new Error(error.message); } },
      };
    });
    await page.clock.install();
    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() => window.petReady);
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 20)));
    // Freeze CSS interpolation when measuring key poses; production transitions
    // remain covered by the stylesheet and the renderer's actual DOM updates.
    await page.addStyleTag({ content: '#pet-motion { transition: none !important; }' });
    const pose = () => page.evaluate(() => {
      const layer = document.getElementById('pet-motion');
      const matrix = new DOMMatrix(getComputedStyle(layer).transform);
      return { y: matrix.m42, scale: parseFloat(getComputedStyle(document.getElementById('pet-sprite')).scale), state: document.getElementById('pet-container').dataset.state,
        frame: document.getElementById('pet-sprite').src };
    });
    const windowBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await page.locator('#pet-container').dispatchEvent('click');
    await page.clock.runFor(140);
    assert.ok((await pose()).y < 0, `bent-leg pose lifts above the floor: ${JSON.stringify(await pose())}`);
    assert.match((await pose()).frame, /\.png$/);
    const qa = path.join(root, 'qa');
    await mkdir(qa, { recursive: true });
    await page.screenshot({ path: path.join(qa, 'jump-airborne.png') });
    await page.clock.runFor(440);
    assert.equal((await pose()).state, 'idle');
    assert.equal((await pose()).y, 0);
    assert.equal((await pose()).scale, 1);
    await page.screenshot({ path: path.join(qa, 'jump-landed.png') });
    await page.clock.runFor(400);
    await page.locator('#pet-container').dispatchEvent('click');
    await page.clock.runFor(600);
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), windowBounds,
      'repeated jumps do not move or resize the Electron window');

    const emit = (activity) => page.evaluate((value) => window.emitActivity(value), activity);
    await emit({ kind: 'interaction', stateId: 'pet', feedback: '摸摸充电中～' });
    await page.clock.runFor(3500);
    await emit({ kind: 'interaction-reply', feedback: '你带来的温柔，刚好够我开心一整天。' });
    await page.clock.runFor(1000);
    assert.equal(await page.locator('#feedback-bubble').evaluate((el) => el.classList.contains('show')), true,
      'the old bubble timer does not hide the AI reply');
    await page.locator('#pet-container').dispatchEvent('click');
    await emit({ kind: 'interaction-reply', feedback: '不该出现的旧回复' });
    assert.doesNotMatch(await page.locator('#feedback-bubble').textContent(), /不该出现/);
    await emit({ kind: 'interaction', stateId: 'pet', feedback: '新的摸摸头' });
    await page.locator('#pet-container').dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
    await page.locator('#pet-container').dispatchEvent('pointermove', { pointerId: 1, clientX: 65, clientY: 50 });
    await page.locator('#pet-container').dispatchEvent('pointerup', { pointerId: 1, clientX: 65, clientY: 50 });
    await emit({ kind: 'interaction-reply', feedback: '拖拽前的旧回复' });
    assert.doesNotMatch(await page.locator('#feedback-bubble').textContent(), /拖拽前/);
    await emit({ kind: 'interaction', stateId: 'walk-right', feedback: '走两步～' });
    await emit({ kind: 'move', stateId: 'walk-right' });
    await emit({ kind: 'interaction-reply', feedback: '桌面探险队出发！' });
    assert.equal(await page.locator('#feedback-bubble').textContent(), '桌面探险队出发！');
    await emit({ kind: 'notify', stateId: 'notify', feedback: '该休息了' });
    await emit({ kind: 'interaction-reply', feedback: '通知前的旧回复' });
    assert.equal(await page.locator('#feedback-bubble').textContent(), '该休息了');
    for (const size of [110, 132, 176, 220, 264, 330]) {
      await page.setViewportSize({ width: size, height: size });
      await emit({ kind: 'interaction', stateId: 'notify', feedback: '温'.repeat(40) });
      await page.clock.runFor(350);
      const bubble = await page.locator('#feedback-bubble').boundingBox();
      assert.ok(bubble.x >= 0 && bubble.y >= 0 && bubble.x + bubble.width <= size + 1 && bubble.y + bubble.height <= size + 1,
        `40-character response must fit the ${size}px pet window: ${JSON.stringify(bubble)}`);
      assert.ok(bubble.y >= size * 0.48,
        `speech must stay below the character's head in the ${size}px pet window: ${JSON.stringify(bubble)}`);
    }
    await page.setViewportSize({ width: 176, height: 176 });
    await emit({ kind: 'interaction-reply', feedback: '今天的小挑战：给自己找一个值得开心的小理由。' });
    await page.screenshot({ path: path.join(qa, 'interaction-bubble.png') });
    assert.deepEqual(errors, []);
    console.log('Pet UI: PASS (jump/landing, repeated clicks, bubble timer/wrapping, stale AI, drag and six sizes; mock IPC only).');
  } finally {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
