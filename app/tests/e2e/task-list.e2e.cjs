// Exercise the real dashboard with simulated account/task IPC. No network or
// real credentials/user profile are accessed, and Electron remains hidden.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const webpack = require('webpack');
const { _electron } = require('@playwright/test');
const closeTestElectron = require('./electron-cleanup.cjs');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hongyi-task-list-ui-'));
  let application;
  try {
    const config = require('../../webpack.renderer.config.js');
    const compiler = webpack({ ...config, mode: 'development', context: root, target: 'web',
      entry: path.join(root, 'src/renderer/dashboard/index.ts'), output: { path: directory, filename: 'dashboard.js', publicPath: '' },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
    const source = await readFile(path.join(root, 'src/renderer/dashboard/index.html'), 'utf8');
    const html = source.replace('</head>', '<link rel="stylesheet" href="main.css"></head>')
      .replace('</body>', '<script src="dashboard.js"></script></body>');
    const htmlFile = path.join(directory, 'index.html');
    await writeFile(htmlFile, html);
    const entry = path.join(directory, 'electron.cjs');
    await writeFile(entry, `const {app, BrowserWindow} = require('electron');
      app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
      app.whenReady().then(() => { global.win = new BrowserWindow({width:520,height:700,frame:false,show:false,
        webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}}); win.loadURL('about:blank'); });`);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [entry], env: environment });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      // The native test window stays hidden. Model the user's visible window so
      // the real one-second refresh loop participates in draft/focus checks.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      let connected = false;
      let remembered = false;
      window.taskReadError = false;
      window.taskWriteError = false;
      window.taskWrites = [];
      window.taskReads = [];
      window.companionReads = 0;
      const item = (id, name, completed = false) => ({ id, name, priority: completed ? 'low' : 'high', completed, createdAt: '2026-10-22T01:00:00Z', reminderAt: null });
      const daily = [item('1', '<img src=x onerror=alert(1)> 这是任务文字'), item('2', '完成第一项任务', true)];
      const weekly = [item('3', '本周交付桌宠联动'), item('4', '整理本周工作', true)];
      window.mockDaily = daily;
      const status = () => ({ connected, remembered, canRemember: true, ...(connected ? { username: 'demo' } : {}) });
      let preferences = { reminders: false, morning: false, morningTime: '09:00', evening: false, eveningTime: '21:00', quiet: true, quietStart: '22:00', quietEnd: '08:00' };
      let focus = { phase: 'idle', seconds: 0, remaining: 0 };
      window.planCalls = 0;
      window.petAPI = {
        settings: { get: async () => ({ petScale: 0.8, soundEnabled: true }), update: async () => ({}) },
        interactions: { list: async () => [], stats: async () => ({ affection: 10, mood: 90, todayInteractions: 2, companionMinutes: 20 }) },
        reminders: { list: async () => [] },
        chat: { history: async () => [], clear: async () => { if (window.clearError) throw new Error('test clear failure'); }, send: async (text) => { window.lastChat = text; if (window.chatError) throw new Error('test transport failure'); if (window.delayChat) return new Promise((resolve) => { window.finishChat = () => resolve(`收到：${text}`); }); return `收到：${text}`; } }, ai: { status: async () => false },
        window: { beginDrag: async () => {}, updateDrag: async () => {}, endDrag: async () => {}, hideDashboard: async () => { window.quickHidden = true; }, showDashboard: async () => { window.emitDashboardMode('full'); } },
        pomodoro: { status: async () => ({ phase: 'idle', endsAt: 0 }) },
        events: { onDisplayName: () => {}, onStats: () => {}, onPomodoro: () => {}, onRemindersUpdated: () => {}, onDashboardMode: (callback) => { window.emitDashboardMode = callback; }, onTaskListUpdated: (callback) => { const previous = window.emitTaskUpdated; window.emitTaskUpdated = () => { previous?.(); callback(); }; } },
        taskList: {
          companion: async () => { window.companionReads++; return { preferences, focus }; },
          configure: async (input) => { if (window.configError) throw new Error('test save failure'); preferences = input; return preferences; },
          focus: async (input) => { focus = input.action === 'stop' ? { phase: 'idle', seconds: 0, remaining: 0 } : { phase: input.action === 'pause' ? 'paused' : 'running', name: '界面测试任务', seconds: 90, remaining: 1500 }; return focus; },
          briefing: async (kind) => `${kind === 'morning' ? '每日简报' : '晚间复盘'}：共 2 项，完成 1 项。`,
          plan: async (input) => { window.planCalls++; return { ai: false, items: ['确定范围', '完成第一版', '验收上线'].map((name) => ({ id: crypto.randomUUID(), kind: 'daily', name, date: input.date, priority: 'medium' })) }; },
          status: async () => status(),
          login: async (input) => {
            if (input.username !== 'demo' || input.password !== 'test-only') throw new Error('登录失败，请检查用户名和密码后重试。');
            connected = true; remembered = input.remember; return status();
          },
          logout: async () => { connected = false; remembered = false; return status(); },
          list: async (view) => {
            window.taskReads.push(view);
            if (window.taskReadError) throw new Error('无法连接任务清单，请检查网络后重试。');
            return { view, date: view === 'week' ? '2026-10-19' : '2026-10-22', fetchedAt: '2026-10-22T03:00:00Z', items: view === 'week' ? weekly : view === 'pending' ? daily.filter((task) => !task.completed) : daily };
          },
          create: async (input) => {
            window.taskWrites.push({ type: 'create', ...input });
            if (window.taskWriteError) throw new Error('任务保存失败，请重试。');
            const tasks = input.kind === 'weekly' ? weekly : daily;
            const saved = item(input.id, input.name); saved.priority = input.priority; tasks.push(saved);
            window.emitTaskUpdated(); return saved;
          },
          update: async (input) => {
            window.taskWrites.push({ type: 'update', ...input });
            if (window.taskWriteError) throw new Error('任务修改失败，请重试。');
            const saved = (input.kind === 'weekly' ? weekly : daily).find((task) => task.id === input.id);
            Object.assign(saved, input.patch); window.emitTaskUpdated(); return saved;
          },
          openWebsite: async () => { window.websiteOpened = true; },
        },
      };
    });
    await page.goto(pathToFileURL(htmlFile).href);
    await page.locator('[data-tab="tasks"]').click();
    assert.equal(await page.locator('#task-login-form').isVisible(), false, 'login does not occupy the task page');
    await page.locator('#task-account-button').click();
    await page.locator('#task-login-form').waitFor({ state: 'visible' });
    await mkdir(path.join(root, 'qa'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'qa', 'task-list-login.png') });
    await page.locator('#task-username').fill('demo');
    await page.locator('#task-password').fill('wrong');
    await page.locator('#task-login-button').click();
    await page.waitForFunction(() => document.getElementById('task-message').textContent.includes('登录失败'));
    assert.equal(await page.locator('#task-password').inputValue(), '', 'password is cleared on a failed login');
    await page.locator('#task-password').fill('test-only');
    await page.locator('#task-login-button').click();
    await page.locator('.linked-task').first().waitFor();
    assert.equal(await page.locator('#task-login-form').isVisible(), false);
    assert.match(await page.locator('#task-summary').textContent(), /1\/2 已完成/);
    assert.match(await page.locator('.linked-task-name').first().textContent(), /<img/);
    assert.equal(await page.locator('#task-items img').count(), 0, 'task content is text, never HTML');
    assert.match(await page.locator('#task-account-button').textContent(), /demo/);
    assert.equal(await page.locator('.task-manual-create').evaluate((el) => el.open), false);
    await page.locator('.task-manual-create > summary').click();
    await page.locator('#task-create-name').fill('新增报告');
    await page.locator('#task-create-date').fill('2026-10-22');
    await page.locator('#task-create-priority').selectOption('high');
    await page.evaluate(() => { window.taskWriteError = true; });
    await page.locator('#task-create-button').click();
    await page.waitForFunction(() => document.getElementById('task-message').textContent.includes('保存失败'));
    assert.equal(await page.locator('#task-create-name').inputValue(), '新增报告');
    await page.evaluate(() => { window.taskWriteError = false; });
    await page.locator('#task-create-button').click();
    await page.waitForFunction(() => document.getElementById('task-items').textContent.includes('新增报告'));
    const createIds = await page.evaluate(() => window.taskWrites.filter((write) => write.type === 'create').map((write) => write.id));
    assert.equal(createIds[0], createIds[1], 'retrying a failed form uses the same id');
    assert.equal(await page.locator('#task-create-name').inputValue(), '');
    await page.locator('.linked-task-state').first().check();
    await page.waitForFunction(() => document.getElementById('task-summary').textContent.includes('2/3 已完成'));
    await page.locator('.linked-task-state').first().uncheck();
    await page.waitForFunction(() => document.getElementById('task-summary').textContent.includes('1/3 已完成'));
    await page.locator('.task-edit-button').first().click();
    await page.locator('.task-editor input[aria-label="修改任务名称"]').fill('修订后的报告');
    await page.locator('.task-editor input[type="datetime-local"]').fill('2026-10-23T15:00');
    await page.locator('.task-editor select').selectOption('low');
    await page.locator('.task-editor button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('task-items').textContent.includes('修订后的报告'));
    assert.match(await page.locator('.linked-task-detail').first().textContent(), /低优先级/);
    assert.equal(await page.evaluate(() => window.taskWrites.findLast((write) => write.type === 'update').patch.reminderAt), '2026-10-23T07:00:00.000Z');
    await page.evaluate(() => { window.mockDaily[0].name = '聊天修改后的报告'; window.emitTaskUpdated(); });
    await page.waitForFunction(() => document.getElementById('task-items').textContent.includes('聊天修改后的报告'));
    await page.locator('#task-view').selectOption('pending');
    await page.waitForFunction(() => document.getElementById('task-summary').textContent.includes('全部未完成：2'));
    assert.equal(await page.locator('#tab-bar .tab-btn').count(), 2, 'only Conversation and Today are primary navigation');
    const qa = path.join(root, 'qa');
    await mkdir(qa, { recursive: true });
    await page.locator('.task-manual-create').evaluate((el) => { el.open = false; });
    await page.locator('#panel-tasks').evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(qa, 'task-list-panel.png') });
    await page.setViewportSize({ width: 480, height: 620 });
    assert.ok(await page.locator('#panel-tasks').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'minimum dashboard width has no horizontal overflow');
    await page.evaluate(() => { window.taskReadError = true; });
    await page.locator('#task-refresh').click();
    await page.waitForFunction(() => document.getElementById('task-message').textContent.includes('检查网络'));
    assert.equal(await page.locator('.linked-task').count(), 0, 'a failed read cannot display stale data as current');
    assert.equal(await page.locator('#task-summary').textContent(), '', 'failure is not an empty-list success');
    await page.evaluate(() => { window.taskReadError = false; });
    await page.locator('#task-refresh').click();
    await page.locator('.linked-task').first().waitFor();
    await page.locator('[data-open-nav="settings"]').first().click();
    await page.locator('[name="reminders"]').check();
    await page.locator('[name="morning"]').check();
    await page.locator('[name="morningTime"]').fill('10:30');
    await page.locator('#ai-base-url').focus();
    const beforeSettingsPoll = await page.evaluate(() => window.companionReads);
    await page.waitForFunction((before) => window.companionReads > before + 1, beforeSettingsPoll);
    assert.equal(await page.locator('[name="morningTime"]').inputValue(), '10:30', 'polling after blur must preserve an unsaved time');
    assert.equal(await page.locator('[name="reminders"]').isChecked(), true);
    await page.evaluate(() => { window.configError = true; });
    await page.locator('.task-companion-settings button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.task-config-message').textContent.includes('保存失败'));
    assert.equal(await page.locator('[name="morningTime"]').inputValue(), '10:30');
    await page.evaluate(() => { window.configError = false; });
    await page.locator('.task-companion-settings button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.task-config-message').textContent === '已保存');
    await page.locator('[data-tab="tasks"]').click();
    await page.locator('#task-view').selectOption('today');
    await page.locator('button[aria-label^="专注："]').first().click();
    await page.waitForFunction(() => document.querySelector('.focus-state').textContent === '专注中');
    await page.locator('[data-tab="chat"]').click();
    await page.locator('.task-chat-focus').waitFor({ state: 'visible' });
    assert.match(await page.locator('.task-chat-focus').textContent(), /界面测试任务.*25:00/);
    await page.locator('.task-chat-focus button').first().focus();
    const beforeFocusPoll = await page.evaluate(() => window.companionReads);
    await page.waitForFunction((before) => window.companionReads > before + 1, beforeFocusPoll);
    assert.equal(await page.locator('.task-chat-focus button').first().evaluate((button) => document.activeElement === button), true, 'polling preserves keyboard focus on the timer controls');
    await page.locator('[data-tab="tasks"]').click();
    await page.locator('[data-focus="toggle"]').click();
    await page.waitForFunction(() => document.querySelector('.focus-state').textContent.includes('已暂停'));
    await page.locator('[data-focus="stop"]').click();
    await page.waitForFunction(() => document.querySelector('.focus-state').textContent === '准备开始');
    assert.equal(await page.locator('.task-chat-focus').isHidden(), true);
    // The lightweight surface uses the same dashboard DOM and chat pipeline.
    await page.setViewportSize({ width: 380, height: 430 });
    await page.evaluate(() => window.emitDashboardMode('quick'));
    await page.locator('#chat-input').waitFor({ state: 'visible' });
    await page.locator('#chat-input').fill('今天有哪些任务');
    await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => window.lastChat === '今天有哪些任务');
    assert.match(await page.locator('#chat-messages').textContent(), /收到：今天有哪些任务/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'quick chat fits its small window');
    await page.screenshot({ path: path.join(qa, 'quick-chat.png') });
    console.log('Dashboard self-check: saved drafts/settings, stable timer focus and quick layout passed.');
    for (const [width, height] of [[320, 320], [380, 430], [480, 620]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('#close-btn').evaluate((button) => {
        const r = button.getBoundingClientRect();
        return [[.25, .5], [.5, .5], [.75, .5]].every(([x, y]) => button.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height * y)));
      }), true, 'close control is clickable across its hit area at each window size');
      await page.evaluate(() => { window.quickHidden = false; });
      await page.locator('#close-btn').click(); assert.equal(await page.evaluate(() => window.quickHidden), true);
    }
    await page.setViewportSize({ width: 380, height: 430 });
    console.log('Dashboard self-check: close-button hit targets passed at 320, 380 and 480 pixels.');
    await page.evaluate(() => { window.chatError = true; });
    await page.locator('#chat-input').fill('新增高优先级任务：测试草稿'); await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
    assert.equal(await page.locator('#chat-input').inputValue(), '新增高优先级任务：测试草稿', 'transport failures restore the submitted draft');
    await page.evaluate(() => { window.chatError = false; window.delayChat = true; });
    await page.locator('#chat-input').fill('慢速回复'); await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => Boolean(window.finishChat));
    assert.equal(await page.locator('#chat-clear').isDisabled(), true);
    assert.equal(await page.locator('[data-chat-prompt]').first().isDisabled(), true);
    await page.locator('#chat-input').fill('下一条草稿');
    await page.evaluate(() => { window.delayChat = false; window.finishChat(); });
    await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
    assert.equal(await page.locator('#chat-input').inputValue(), '下一条草稿');
    console.log('Dashboard self-check: transport failure and pending-reply controls passed.');
    await page.evaluate(() => {
      window.petAPI.chat.history = () => new Promise((resolve) => { window.finishHistory = resolve; });
      window.dispatchEvent(new Event('pet:account'));
    });
    await page.locator('#chat-input').fill('历史读取期间的新消息'); await page.locator('#chat-input').press('Enter');
    await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('收到：历史读取期间的新消息'));
    await page.evaluate(() => window.finishHistory([{ role: 'assistant', content: '旧记录' }]));
    assert.match(await page.locator('#chat-messages').textContent(), /历史读取期间的新消息/);
    await page.evaluate(() => { window.clearError = true; });
    await page.locator('#chat-clear').click();
    await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('清空失败'));
    assert.match(await page.locator('#chat-messages').textContent(), /历史读取期间的新消息/);
    await page.evaluate(() => { window.clearError = false; });
    await page.evaluate(() => { window.petAPI.chat.history = async () => []; });
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => window.quickHidden), true);
    await page.locator('#quick-open-house').click();
    assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('quick-chat')), false);
    await page.setViewportSize({ width: 480, height: 620 });
    await page.locator('[data-tab="tasks"]').click();
    await page.locator('#task-account-button').click();
    await page.locator('#task-logout').click();
    await page.locator('#task-disconnected').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.linked-task').count(), 0);
    await page.locator('#task-open-website').click();
    assert.equal(await page.evaluate(() => window.websiteOpened), true);
    assert.deepEqual(errors, []);
    console.log('Task-list dashboard: PASS (account, task edits, reminders, secondary settings, unified focus, two primary tabs, compact chat/Enter/Escape/full mode, network failures; simulated IPC).');
  } finally {
    if (application) await closeTestElectron(application);
    try { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { if (error.code === 'EBUSY' || error.code === 'EPERM') console.warn(`Temporary test profile is still locked; retained at ${directory}`); else throw error; }
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
