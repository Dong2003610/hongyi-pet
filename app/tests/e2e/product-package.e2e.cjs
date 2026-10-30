// Smoke the actual extracted portable executable with an isolated empty profile.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const executable = path.resolve(process.argv[2]);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'hongyi-product-package-'));
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve));
  const environment = { ...process.env, PET_E2E: '1', PET_E2E_USER_DATA: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  let browser;
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(browser, `Packaged app failed to start: ${output.slice(-2000)}`);
    let pet; let dashboard;
    while (Date.now() < deadline) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      pet = pages.find((page) => page.url().includes('/pet_window/'));
      dashboard = pages.find((page) => page.url().includes('/dashboard_window/'));
      if (pet && dashboard) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pet && dashboard);
    await pet.waitForFunction(() => window.petAPI && document.querySelector('#pet-sprite').naturalWidth > 0);
    await dashboard.waitForFunction(() => window.petAPI && document.querySelector('#task-companion .focus-state'));
    await pet.locator('#pet-container').dispatchEvent('dblclick');
    await dashboard.waitForFunction(() => document.body.classList.contains('quick-chat'));
    await dashboard.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await pet.waitForFunction(async () => (await window.__petE2E.snapshot()).roles.find((role) => role.role === 'dashboard')?.visible === false);
    await pet.locator('#pet-container').dispatchEvent('dblclick');
    await pet.waitForFunction(async () => (await window.__petE2E.snapshot()).roles.find((role) => role.role === 'dashboard')?.visible === true);
    await dashboard.locator('#chat-input').fill('自由专注1分钟'); await dashboard.locator('#chat-input').press('Enter');
    await dashboard.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('已开始自由专注'));
    assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.companion())).focus.phase, 'running');
    await dashboard.locator('#quick-open-house').click();
    await dashboard.waitForFunction(() => !document.body.classList.contains('quick-chat'));
    assert.equal(await dashboard.locator('#tab-bar .tab-btn').count(), 2);
    await dashboard.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await pet.waitForFunction(async () => (await window.__petE2E.snapshot()).roles.find((role) => role.role === 'dashboard')?.visible === false);
    await pet.evaluate(() => window.petAPI.window.showDashboard());
    await pet.waitForFunction(async () => (await window.__petE2E.snapshot()).roles.find((role) => role.role === 'dashboard')?.visible === true);
    await dashboard.evaluate(() => window.petAPI.taskList.focus({ action: 'pause' }));
    assert.equal((await dashboard.evaluate(() => window.petAPI.taskList.companion())).focus.phase, 'paused');
    await dashboard.evaluate(() => window.petAPI.taskList.focus({ action: 'stop' }));
    await dashboard.locator('[data-open-nav="settings"]').first().click();
    await dashboard.locator('#ai-base-url').waitFor({ state: 'visible' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await pet.evaluate(() => window.__petE2E.quit());
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged app did not quit')), 10000))]);
    const saved = JSON.parse(await readFile(path.join(profile, 'chat-history.json'), 'utf8'));
    assert.ok(saved.some((message) => message.source === 'task'));
    const report = { status: 'pass', executable, timestamp: new Date().toISOString(), checks: ['asar startup and pet assets', 'double-click quick chat', 'close and reopen quick chat', 'close and reopen full dashboard', 'real chat focus IPC', 'quick-to-full button', 'two primary tabs', 'pause and stop', 'AI configuration surface', 'persistent task receipts', 'graceful exit'], isolatedProfile: true, realAccountUsed: false };
    await writeFile(path.resolve('qa/product-package-smoke.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Portable product smoke: PASS (actual extracted ZIP, isolated profile, no real account).');
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
