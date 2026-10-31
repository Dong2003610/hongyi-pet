// Compile and launch the real main, preload and three renderers, using only an
// isolated profile. No login/network requests or production task writes occur.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const webpack = require('webpack');
const { _electron } = require('@playwright/test');
const closeTestElectron = require('./electron-cleanup.cjs');
const { createServer } = require('node:http');

async function taskServer() {
  const user = '00000000-0000-4000-8000-000000000099';
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  let version = 0; let failWrites = false;
  const metadata = {};
  const rows = ['整理产品方案', '完成桌宠联动'].map((name, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, user_id: user, name, priority: 'medium', completed: false,
    created_at: new Date(`${day}T09:00:00+08:00`).toISOString(), updated_at: new Date(Date.now() + version++).toISOString(), completed_at: null, reminder_at: null, reminder_method: null, elapsed_seconds: 0, sort_order: index }));
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(request.url, 'http://127.0.0.1'); const query = url.searchParams;
    const send = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname.includes('/token')) return send({ access_token: 'test-only', refresh_token: 'test-only-refresh', expires_in: 3600, user: { id: user } });
    if (url.pathname === '/auth/v1/user') { if (request.method === 'PUT') Object.assign(metadata, body.data); return send({ id: user, user_metadata: metadata }); }
    if (!url.pathname.startsWith('/rest/v1/tasks')) return send([]);
    if (failWrites && ['POST', 'PATCH'].includes(request.method)) return send({ error: 'simulated failure' }, 503);
    const selected = rows.filter((row) => {
      if (query.has('id') && query.get('id') !== `eq.${row.id}`) return false;
      if (query.has('user_id') && query.get('user_id') !== `eq.${row.user_id}`) return false;
      if (query.has('completed') && query.get('completed') !== `eq.${row.completed}`) return false;
      if (query.has('updated_at') && query.get('updated_at') !== `eq.${row.updated_at}`) return false;
      if (query.has('elapsed_seconds') && row.elapsed_seconds > Number(query.get('elapsed_seconds').slice(4))) return false;
      if (query.has('created_at') && Date.parse(row.created_at) < Date.parse(query.get('created_at').slice(4))) return false;
      if (query.has('and') && Date.parse(row.created_at) >= Date.parse(query.get('and').slice('(created_at.lt.'.length, -1))) return false;
      return true;
    });
    if (request.method === 'POST') { if (rows.some((row) => row.id === body.id)) return send([]); const saved = { ...body, sort_order: null, updated_at: new Date(Date.now() + version++).toISOString() }; rows.push(saved); return send([saved]); }
    if (request.method === 'PATCH') selected.forEach((row) => Object.assign(row, body, { updated_at: new Date(Date.now() + version++).toISOString() }));
    return send(selected);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, rows, metadata, day, url: `http://127.0.0.1:${server.address().port}`, fail(value) { failWrites = value; } };
}

function compile(config) {
  const compiler = webpack(config);
  return new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close(() => {});
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
    else resolve();
  }));
}
async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-integration-'));
  let application;
  const backend = await taskServer();
  try {
    const fixture = path.join(directory, 'task-public.json');
    await writeFile(fixture, JSON.stringify({ url: backend.url, publicKey: 'test-only' }));
    const definitions = {};
    await Promise.all(['pet', 'dashboard', 'reminder'].map(async (role) => {
      const output = path.join(directory, `${role}_window`); await mkdir(output);
      await compile({ ...require('../../webpack.renderer.config.js'), mode: 'development', context: root, target: 'web',
        entry: path.join(root, `src/renderer/${role}/index.ts`), output: { path: output, filename: 'renderer.js', publicPath: '' },
      });
      const html = (await readFile(path.join(root, `src/renderer/${role}/index.html`), 'utf8'))
        .replace('</head>', '<link rel="stylesheet" href="main.css"></head>').replace('</body>', '<script src="renderer.js"></script></body>');
      await writeFile(path.join(output, 'index.html'), html);
      definitions[`${role.toUpperCase()}_WINDOW_WEBPACK_ENTRY`] = JSON.stringify(pathToFileURL(path.join(output, 'index.html')).href);
      definitions[`${role.toUpperCase()}_WINDOW_PRELOAD_WEBPACK_ENTRY`] = JSON.stringify(path.join(directory, 'preload.cjs'));
    }));
    await Promise.all([
      compile({ ...require('../../webpack.main.config.js'), mode: 'development', context: root, output: { path: directory, filename: 'main.cjs', publicPath: directory.replace(/\\/g, '/') + '/' }, plugins: [
        // Capture only the autonomous 18–40s scheduler; exercise its real
        // callback deterministically without changing production timing.
        new webpack.BannerPlugin({ raw: true, banner: `(()=>{const originalTimeout=globalThis.setTimeout;globalThis.setTimeout=(callback,delay,...args)=>{if(delay>=18000&&delay<=40000)globalThis.__testPatrol=callback;return originalTimeout(callback,delay,...args)}})();` }),
        new webpack.BannerPlugin({ raw: true, banner: `(()=>{const originalFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{const value=typeof input==='string'?input:input.url;const url=new URL(value);if(['www.ithome.com','www.solidot.org','openai.com','www.cnbc.com','www.federalreserve.gov','www.ecb.europa.eu','www.un.org'].includes(url.hostname)){const now=new Date().toUTCString();return new Response('<rss><channel>'+[0,1,2].map(i=>'<item><title>'+url.hostname+' 测试新闻 '+i+'</title><link>https://'+url.hostname+'/test/article-'+i+'</link><description>本地模拟摘要 '+i+'</description><pubDate>'+now+'</pubDate></item>').join('')+'</channel></rss>',{headers:{'Content-Type':'application/rss+xml'}})}if(['127.0.0.1','localhost','[::1]'].includes(url.hostname))return originalFetch(input,init);throw new Error('E2E external network blocked: '+url.hostname)}})();` }),
        new webpack.DefinePlugin(definitions), new webpack.NormalModuleReplacementPlugin(/task-list-public\.json$/, fixture)] }),
      compile({ mode: 'development', context: root, target: 'electron-preload', entry: path.join(root, 'src/preload.ts'), output: { path: directory, filename: 'preload.cjs' }, module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: 'ts-loader' }] }, resolve: { extensions: ['.ts', '.js'] } }),
    ]);
    const env = { ...process.env, PET_E2E: '1', PET_E2E_USER_DATA: path.join(directory, 'profile') }; delete env.ELECTRON_RUN_AS_NODE;
    // Keep the Windows launch wrapper's cwd outside the disposable directory;
    // otherwise it can hold the empty temp root open after Electron exits.
    application = await _electron.launch({ args: [path.join(directory, 'main.cjs')], cwd: root, env });
    let pet; let dashboard;
    // The main process has its own readiness gate; wait on actual renderer IPC.
    for (let attempt = 0; attempt < 100; attempt++) {
      const windows = application.windows();
      pet = windows.find((page) => page.url().includes('/pet_window/'));
      dashboard = windows.find((page) => page.url().includes('/dashboard_window/'));
      if (pet && dashboard && await pet.evaluate(() => Boolean(window.petAPI)).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pet && dashboard, 'real pet and dashboard exist');
    await pet.waitForFunction(() => Boolean(window.petAPI && document.querySelector('#pet-sprite').naturalWidth));
    await dashboard.waitForFunction(() => Boolean(window.petAPI && document.querySelector('#task-companion .task-tools')));
    const initial = await pet.evaluate(() => window.__petE2E.snapshot());
    assert.equal(initial.roles.length, 3); assert.equal(initial.tray, true);
    assert.equal(await pet.evaluate(() => window.petAPI.updates.status().then(() => false, () => true)), true, 'pet renderer cannot install or configure updates');
    assert.equal((await dashboard.evaluate(() => window.petAPI.updates.status())).phase, 'unsupported', 'isolated source integration never invokes a real update');
    assert.equal(await dashboard.evaluate(() => window.petAPI.updates.apply().then(() => false, () => true)), true, 'dev/E2E installation is blocked');
    assert.equal(await pet.evaluate(() => window.petAPI.taskList.status().then(() => false, () => true)), true, 'pet has no task credential IPC access');
    assert.equal(await pet.evaluate(() => window.petAPI.news.status().then(() => false, () => true)), true, 'main denies pet-role news IPC access');
    assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.status())).connected, false);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/pet_window/')).webContents.getBackgroundThrottling()), false, 'pet animation remains active while unfocused');
    const petPose = () => pet.evaluate(() => ({ state: document.querySelector('#pet-container').dataset.state, frame: document.querySelector('#pet-sprite').src }));
    for (const direction of [-1, 1]) {
      const before = await application.evaluate(({ BrowserWindow, screen }, direction) => {
        const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/'));
        const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
        win.setPosition(Math.round(area.x + area.width / 2 - bounds.width / 2), bounds.y);
        win.webContents.send('state:activity', { kind: 'interaction', stateId: 'sleep', durationMs: 15000 });
        const initial = win.getBounds(); const random = Math.random;
        try { Math.random = () => direction < 0 ? .25 : .75; globalThis.__testPatrol(); } finally { Math.random = random; }
        return initial;
      }, direction);
      await pet.waitForFunction(state => document.querySelector('#pet-container').dataset.state === state, direction < 0 ? 'walk-left' : 'walk-right');
      const frames = new Set();
      for (let i = 0; i < 6; i++) {
        const pose = await petPose(); assert.equal(pose.state, direction < 0 ? 'walk-left' : 'walk-right'); frames.add(pose.frame);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.ok(frames.size >= 4, 'real patrol changes walking frames, not a standing glide');
      const moved = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/')).getBounds());
      assert.ok((moved.x - before.x) * direction > 0, 'window moves in the same direction as the walking pose');
      await pet.waitForFunction(() => document.querySelector('#pet-container').dataset.state === 'idle');
    }
    // A new interaction interrupts both the window movement and the walk pose.
    await application.evaluate(() => { globalThis.__testPatrol(); });
    await pet.waitForFunction(() => /walk-/.test(document.querySelector('#pet-container').dataset.state));
    await pet.evaluate(() => window.petAPI.interactions.trigger('feed-snack'));
    const stopped = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/')).getBounds());
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/')).getBounds()), stopped, 'interacting with the pet stops patrol translation');
    // Exercise the actual "let her walk" IPC, including restarting before the
    // previous walk finishes and starting again after it has fully stopped.
    await application.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/'));
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setPosition(area.x + 24, win.getBounds().y);
    });
    await pet.evaluate(() => window.petAPI.interactions.trigger('take-walk'));
    await pet.waitForFunction(() => document.querySelector('#pet-container').dataset.state === 'walk-right');
    await new Promise(resolve => setTimeout(resolve, 900));
    await pet.evaluate(() => window.petAPI.interactions.trigger('take-walk'));
    const secondStart = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/')).getBounds());
    const repeatedFrames = new Set();
    for (let i = 0; i < 17; i++) {
      const pose = await petPose();
      assert.equal(pose.state, 'walk-right', 'the second real walk never falls back to standing at the first deadline');
      repeatedFrames.add(pose.frame); await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(repeatedFrames.size, 5, 'repeated real walking cycles all five approved frames');
    const secondEnd = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/pet_window/')).getBounds());
    assert.ok(secondEnd.x > secondStart.x, 'second walking animation accompanies actual translation');
    await pet.waitForFunction(() => document.querySelector('#pet-container').dataset.state === 'idle');
    await pet.evaluate(() => window.petAPI.interactions.trigger('take-walk'));
    await pet.waitForFunction(() => document.querySelector('#pet-container').dataset.state === 'walk-right');
    const afterCompleteFrame = (await petPose()).frame;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.notEqual((await petPose()).frame, afterCompleteFrame, 'walking after a completed walk still animates');
    await pet.evaluate(() => window.petAPI.interactions.trigger('feed-snack'));
    assert.deepEqual(await dashboard.evaluate(() => window.petAPI.news.status().then(value => value.preferences)), { enabled: false, time: '09:00' }, 'daily news push is disabled by default');
    assert.equal(await dashboard.evaluate(() => window.petAPI.news.open('https://evil.example/article').then(() => false, () => true)), true, 'news links reject untrusted hosts');

    await pet.locator('#pet-container').dispatchEvent('dblclick');
    await dashboard.waitForFunction(() => document.body.classList.contains('quick-chat'));
    await dashboard.locator('#close-btn').click({ timeout: 3000 });
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/dashboard_window/')).isVisible()), false, 'the real close button hides quick chat');
    await pet.locator('#pet-container').dispatchEvent('dblclick');
    await dashboard.waitForFunction(() => document.body.classList.contains('quick-chat'));
    const quick = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/dashboard_window/')).getBounds());
    assert.ok(quick.width <= 400 && quick.height <= 450);
    await dashboard.locator('#chat-input').fill('每日简报');
    await dashboard.locator('#chat-input').press('Enter');
    await dashboard.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('连接原清单账号'));
    await dashboard.keyboard.press('Escape');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/dashboard_window/')).isVisible()), false);
    await pet.evaluate(() => window.petAPI.window.showDashboard());
    await dashboard.waitForFunction(() => !document.body.classList.contains('quick-chat'));
    await dashboard.locator('[data-tab="tasks"]').click();
    await dashboard.locator('#task-account-button').click();
    await dashboard.locator('#task-account-dialog').waitFor({ state: 'visible' });
    await dashboard.locator('#task-account-close').click();
    assert.equal(await dashboard.locator('#tab-bar .tab-btn').count(), 2);
    const sendChat = async (text) => {
      const before = await dashboard.locator('.chat-msg.from-pet').count();
      await dashboard.locator('[data-tab="chat"]').click(); await dashboard.locator('#chat-input').fill(text); await dashboard.locator('#chat-input').press('Enter');
      await dashboard.waitForFunction((count) => document.querySelectorAll('.chat-msg.from-pet').length > count && !document.querySelector('#chat-send').disabled, before);
      return dashboard.locator('.chat-msg.from-pet').last();
    };
    // Free focus and recurring reminders work with the real main while logged out.
    assert.match(await (await sendChat('自由专注25分钟')).textContent(), /已开始自由专注/);
    assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.companion())).focus.free, true);
    await sendChat('暂停一下'); assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.companion())).focus.phase, 'paused');
    await sendChat('结束计时');
    await sendChat('每天下午三点提醒我喝水');
    assert.equal((await dashboard.evaluate(() => window.petAPI.reminders.list())).length, 1);

    await dashboard.evaluate(() => window.petAPI.chat.clear());
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/dashboard_window/'));
      window.setSize(600, 1000);
    });
    const newsDigest = await sendChat('今天有什么AI新闻');
    assert.match(await newsDigest.textContent(), /AI新闻|北京时间/);
    assert.equal(await newsDigest.locator('.chat-card.card-news').count(), 3);
    assert.equal(await newsDigest.locator('.news-source-link').count(), 3);
    await dashboard.locator('#chat-messages').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await dashboard.screenshot({ path: path.join(root, 'qa/news-briefing.png') });
    const firstNewsTitle = await newsDigest.locator('.chat-card.card-news strong').first().textContent();
    await newsDigest.getByRole('button', { name: '摘要与解读' }).first().click();
    await dashboard.waitForFunction(() => document.querySelectorAll('.chat-msg.from-pet').length > 0 && document.querySelector('#chat-messages').textContent.includes('订阅源摘要'));
    assert.ok((await dashboard.locator('.chat-msg.from-pet').last().textContent()).includes(firstNewsTitle.slice(3)), 'summary action retains the selected news item');
    const newsFollowup = await sendChat('第二条新闻详细讲讲'); assert.match(await newsFollowup.textContent(), /OpenAI 官方|订阅源摘要/);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/dashboard_window/'));
      window.setSize(500, 660);
    });
    const newsHistory = await dashboard.evaluate(() => window.petAPI.chat.history());
    assert.ok(newsHistory.some(message => message.source === 'news' && message.cards?.some(card => card.kind === 'news' && card.url?.startsWith('https://openai.com/'))));
    assert.ok(newsHistory.filter(message => message.source === 'news').every(message => !message.cards || message.cards.every(card => !card.actions?.length)));
    await dashboard.evaluate(() => window.petAPI.news.configure({ enabled: true, time: '08:45' }));
    assert.deepEqual(await dashboard.evaluate(() => window.petAPI.news.status().then(value => value.preferences)), { enabled: true, time: '08:45' });
    await dashboard.evaluate(() => window.petAPI.news.configure({ enabled: false, time: '08:45' }));

    await dashboard.evaluate(() => window.petAPI.taskList.login({ username: 'fixture', password: 'test-only', remember: false }));
    const queryReply = await sendChat('今天有哪些任务'); assert.equal(await queryReply.locator('.chat-card').count(), 2);
    await queryReply.locator('.chat-card').first().getByRole('button', { name: '选中这项' }).click();
    await dashboard.waitForFunction(() => document.querySelector('#chat-selection').textContent.includes('整理产品方案'));
    assert.match(await (await sendChat('帮我把第二项任务改成高优先级可以吗？')).textContent(), /优先级已改为高/);
    assert.equal(backend.rows[1].priority, 'high');
    await dashboard.locator('.chat-msg.from-pet').last().getByRole('button', { name: '撤销修改' }).click();
    await dashboard.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('已撤销')); assert.equal(backend.rows[1].priority, 'medium');
    await sendChat('把完成桌宠联动改到明天'); assert.notEqual(new Date(Date.parse(backend.rows[1].created_at) + 8 * 3600_000).toISOString().slice(0, 10), backend.day);
    await sendChat('改到今天');
    await sendChat('十分钟后提醒我完成桌宠联动'); assert.equal(backend.rows.length, 2); assert.ok(backend.rows[1].reminder_at);
    await sendChat('开启到点提醒'); assert.equal(backend.metadata.dtl_reminder_owner_v1, 'desktop');
    await sendChat('先做这个，25分钟'); assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.companion())).focus.phase, 'running');
    await sendChat('暂停一下'); await sendChat('结束计时');
    backend.fail(true); const failed = await sendChat('把整理产品方案标记完成'); assert.doesNotMatch(await failed.textContent(), /已标记完成/); assert.equal(await failed.locator('.card-error').count(), 1); backend.fail(false);
    // Query cards survive persistence but executable grants are never restored.
    const history = await dashboard.evaluate(() => window.petAPI.chat.history()); assert.ok(history.some((message) => message.source === 'task' && message.cards?.length));
    assert.ok(history.every((message) => message.cards?.every((card) => !card.actions?.length) ?? true));
    const savedHistory = JSON.parse(await readFile(path.join(directory, 'profile/chat-history.json'), 'utf8')); assert.ok(savedHistory.some((message) => message.source === 'task'));
    await sendChat('今天有哪些任务');
    await mkdir(path.join(root, 'qa'), { recursive: true });
    await dashboard.screenshot({ path: path.join(root, 'qa/product-conversation.png') });
    await dashboard.locator('[data-tab="tasks"]').click(); await dashboard.locator('.linked-task').first().waitFor();
    await dashboard.screenshot({ path: path.join(root, 'qa/product-today.png') });
    const priorityCreate = await sendChat('新增高优先级任务：XXXXX');
    assert.match(await priorityCreate.textContent(), /已添加任务/);
    assert.equal(backend.rows.find((row) => row.name === 'XXXXX')?.priority, 'high');
    const countBeforeMissingTitle = backend.rows.length;
    assert.match(await (await sendChat('新增一个高优先级任务')).textContent(), /缺少任务名称/);
    assert.equal(backend.rows.length, countBeforeMissingTitle, 'priority without a title cannot create a placeholder task');
    await dashboard.evaluate(() => window.petAPI.taskList.logout());
    const loggedOutHistory = await dashboard.evaluate(() => window.petAPI.chat.history());
    assert.ok(loggedOutHistory.every((message) => message.source !== 'task' || message.accountId === 'local'), 'task receipts are scoped to the active account');
    await dashboard.waitForFunction(() => document.querySelector('#chat-selection').hidden);
    await dashboard.evaluate(() => window.petAPI.settings.update({ petScale: 0.5 }));
    await pet.evaluate(() => window.petAPI.window.showFeedback('人物头顶的清晰文字'));
    const overlay = await application.evaluate(({ BrowserWindow }) => {
      const pet = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('/pet_window/'));
      const bubble = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('data:text/html'));
      return { pet: pet.getBounds(), bubble: bubble.getBounds(), visible: bubble.isVisible(), focusable: bubble.isFocusable() };
    });
    assert.equal(overlay.visible, true); assert.equal(overlay.focusable, false); assert.equal(overlay.bubble.width, 280);
    assert.ok(overlay.bubble.y + overlay.bubble.height <= overlay.pet.y || overlay.bubble.x + overlay.bubble.width <= overlay.pet.x || overlay.bubble.x >= overlay.pet.x + overlay.pet.width);
    console.log('Full integration: PASS (real main/preload/renderer, isolated local fake backend, task cards, natural requests, undo, date changes, selected context, reminder routing, free/task focus, persistent receipts, failure feedback, IPC and pet surfaces; no real account or external network).');
  } finally {
    if (application) await closeTestElectron(application);
    await new Promise((resolve) => backend.server.close(resolve));
    try { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { if (error.code === 'EBUSY' || error.code === 'EPERM') console.warn(`Temporary test profile is still locked; retained at ${directory}`); else throw error; }
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
