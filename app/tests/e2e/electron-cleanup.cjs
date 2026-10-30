const { execFile } = require('node:child_process');

// Playwright on Windows can retain the cmd wrapper after Electron has exited.
// Bound graceful shutdown, then terminate only the exact process tree launched
// by this test. Never enumerate or terminate unrelated Electron applications.
module.exports = async function closeTestElectron(application) {
  const testProcess = application.process();
  let electronPid;
  let pidTimer;
  try { electronPid = await Promise.race([application.evaluate(() => process.pid).catch(() => undefined), new Promise((resolve) => { pidTimer = setTimeout(resolve, 1000); })]); }
  finally { if (pidTimer) clearTimeout(pidTimer); }
  let timer;
  try {
    await Promise.race([
      application.close().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 3000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
  if (process.platform === 'win32') {
    // npm's Windows .cmd launcher can exit before its Electron child does.
    // Capture Electron's own PID before graceful quit, not by process scanning.
    const pids = new Set([electronPid, ...(testProcess.exitCode === null ? [testProcess.pid] : [])].filter(Number.isInteger));
    for (const pid of pids) await new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
    });
  } else if (testProcess.exitCode === null && testProcess.pid) {
    testProcess.kill('SIGKILL');
  }
};
