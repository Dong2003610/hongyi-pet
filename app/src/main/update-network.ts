import { net } from 'electron';

// One Chromium request per URL, using system trust/proxy and explicit redirects.
export const updateFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const request = net.request({ url, method: 'GET', redirect: 'manual' });
  let settled = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => init?.signal?.removeEventListener('abort', abort);
  const fail = (error: unknown) => {
    cleanup();
    if (stream) { try { stream.error(error); } catch {} stream = undefined; }
    if (!settled) { settled = true; reject(error); }
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
    const headers = new Headers();
    for (const [name, values] of Object.entries(response.headers)) for (const value of Array.isArray(values) ? values : [String(values)]) headers.append(name, value);
    if ([204, 205, 304].includes(response.statusCode)) {
      settled = true; cleanup(); resolve(new Response(null, { status: response.statusCode, headers })); request.abort(); return;
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        response.on('data', chunk => {
          if (!stream) return;
          stream.enqueue(new Uint8Array(chunk));
          // Electron IncomingMessage has no pause/resume API. Keep a bounded
          // queue; if disk falls far behind, abort and let Range retry continue.
          if ((stream.desiredSize ?? 0) < 0) { fail(new Error('更新写入暂时繁忙，可继续下载')); request.abort(); }
        });
        response.on('end', () => { cleanup(); stream?.close(); stream = undefined; });
        response.on('error', fail);
        response.on('aborted', () => fail(new Error('更新连接中断，可继续下载')));
      },
      cancel() { cleanup(); stream = undefined; request.abort(); },
    }, { highWaterMark: 8 * 1024 * 1024, size: chunk => chunk.byteLength });
    settled = true;
    resolve(new Response(body, { status: response.statusCode, headers }));
  });
  try {
    new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    if (init?.signal?.aborted) { abort(); return; }
    init?.signal?.addEventListener('abort', abort, { once: true }); request.end();
  } catch (error) { fail(error); request.abort(); }
});
