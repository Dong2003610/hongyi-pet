import { net } from 'electron';

// Chromium uses Windows trust/proxy settings. Its fetch API rejects manual
// redirects, so expose net.request redirects to the updater's URL allowlist.
export const updateFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const request = net.request({ url, method: 'GET', redirect: 'manual' });
  let settled = false;
  const cleanup = () => init?.signal?.removeEventListener('abort', abort);
  const fail = (error: unknown) => {
    if (settled) return; settled = true; cleanup(); reject(error);
  };
  const abort = () => { fail(init?.signal?.reason ?? new Error('更新请求已取消')); request.abort(); };
  request.on('error', fail);
  request.on('redirect', (status, _method, location) => {
    if (settled) return;
    settled = true; cleanup();
    resolve(new Response(null, { status, headers: { location } })); request.abort();
  });
  request.on('response', response => {
    if (settled) { request.abort(); return; }
    // Probe only until headers. Fetch provides a bounded streaming body while
    // redirect:error prevents a changed response bypassing the URL allowlist.
    response.on('error', () => {});
    settled = true; cleanup(); request.abort();
    resolve(net.fetch(url, { ...init, redirect: 'error' }));
  });
  try {
    new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    if (init?.signal?.aborted) { abort(); return; }
    init?.signal?.addEventListener('abort', abort, { once: true }); request.end();
  } catch (error) { fail(error); request.abort(); }
});
