import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTaskListReply, parseTaskListQuery, TaskListService, taskListDate, taskListWeek } from '../../src/main/task-list';

const userId = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-25T16:01:00Z'); // Monday in Shanghai; Sunday in UTC.
const token = (access = 'test-access', refresh = 'test-refresh') => ({ access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: userId } });
const task = (n = 1) => ({ id: id(n), name: `任务 ${n}`, priority: 'high', completed: false, created_at: '2026-10-25T16:00:00Z', reminder_at: null });

function fixture(handler?: (url: URL, init: RequestInit) => Response | Promise<Response>, canRemember = true) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const saves: unknown[] = [];
  let stored: unknown = null;
  const service = new TaskListService({
    url: 'https://example.supabase.co', publicKey: 'test-public', canRemember: () => canRemember, now: () => now,
    load: async () => stored,
    save: async (value) => { saves.push(value); stored = value; },
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      return handler ? handler(parsed, init) : Response.json(parsed.pathname.includes('/token') ? token() : []);
    }) as typeof fetch,
  });
  return { service, calls, saves, setStored: (value: unknown) => { stored = value; } };
}

test('uses the task website Shanghai day and Monday week at UTC Sunday boundary', () => {
  assert.equal(taskListDate(now), '2026-10-26');
  assert.equal(taskListWeek(now), '2026-10-26');
  assert.equal(taskListWeek(new Date('2026-10-25T15:59:00Z')), '2026-10-19');
  assert.equal(taskListWeek(new Date('2026-01-01T00:00:00Z')), '2025-12-29');
});

test('recognizes read queries and never translates task mutations into writes', () => {
  for (const query of ['今天有哪些任务', '今天还有什么没做', '我今天还有什么没做', '查看今日待办']) assert.equal(parseTaskListQuery(query), 'today', query);
  for (const query of ['本周计划是什么', '看看这周的任务']) assert.equal(parseTaskListQuery(query), 'week', query);
  for (const query of ['全部未完成任务', '查看待办清单', '我还有哪些未完成任务']) assert.equal(parseTaskListQuery(query), 'pending', query);
  for (const query of ['帮我添加今天的任务', '把任务标记完成', '删除本周计划']) assert.equal(parseTaskListQuery(query), 'unsupported', query);
  for (const query of ['今天的天气', '十分钟后提醒我喝水', '讲个故事', '这个任务让我很烦']) assert.equal(parseTaskListQuery(query), undefined, query);
});

test('login uses the existing username mapping and never persists password or exposes tokens in status', async () => {
  const { service, calls, saves } = fixture();
  const status = await service.login({ username: ' alice ', password: 'private-test-password', remember: true });
  assert.equal(JSON.parse(String(calls[0]!.init.body)).email, 'alice@miaoda.com');
  assert.deepEqual(status, { connected: true, username: 'alice', remembered: true, canRemember: true });
  assert.doesNotMatch(JSON.stringify(saves), /private-test-password/);
  assert.doesNotMatch(JSON.stringify(status), /test-access|test-refresh/);
  assert.equal((calls[0]!.init.headers as Record<string, string>).apikey, 'test-public');
});

test('session-only login persists no token and remembering requires encryption support', async () => {
  const { service, saves, calls } = fixture(undefined, false);
  await assert.rejects(service.login({ username: 'alice', password: 'test', remember: true }), /加密存储/);
  assert.equal(calls.length, 0);
  await service.login({ username: 'alice', password: 'test', remember: false });
  assert.deepEqual(saves, [null]);
  assert.equal(service.status().remembered, false);
});

test('today query is user-scoped and excludes adjacent Shanghai days with a half-open range', async () => {
  const { service, calls } = fixture((url) => Response.json(url.pathname.includes('/token') ? token() : [task()]));
  await service.login({ username: 'alice', password: 'test', remember: false });
  const snapshot = await service.list('today');
  const request = calls[1]!;
  assert.equal(request.init.method, undefined);
  assert.equal(request.url.pathname, '/rest/v1/tasks');
  assert.equal(request.url.searchParams.get('user_id'), `eq.${userId}`);
  assert.equal(request.url.searchParams.get('created_at'), 'gte.2026-10-25T16:00:00.000Z');
  assert.equal(request.url.searchParams.get('and'), '(created_at.lt.2026-10-26T16:00:00.000Z)');
  assert.equal((request.init.headers as Record<string, string>).Authorization, 'Bearer test-access');
  assert.equal(snapshot.items[0]!.name, '任务 1');
});

test('pending reads all pages, filters unfinished tasks server-side, and returns no partial success', async () => {
  const { service, calls } = fixture((url) => {
    if (url.pathname.includes('/token')) return Response.json(token());
    return Response.json(url.searchParams.has('id') ? [task(501)] : Array.from({ length: 500 }, (_, n) => task(n + 1)));
  });
  await service.login({ username: 'alice', password: 'test', remember: false });
  const snapshot = await service.list('pending');
  assert.equal(snapshot.items.length, 501);
  assert.equal(calls[1]!.url.searchParams.get('completed'), 'eq.false');
  assert.equal(calls[2]!.url.searchParams.get('id'), `gt.${id(500)}`);
  assert.equal(calls[1]!.url.searchParams.has('created_at'), false);
});

test('weekly query uses current Shanghai Monday and reports a missing table as an error', async () => {
  const { service, calls } = fixture((url) => url.pathname.includes('/token') ? Response.json(token()) : new Response('', { status: 404 }));
  await service.login({ username: 'alice', password: 'test', remember: false });
  await assert.rejects(service.list('week'), /周计划尚未启用/);
  assert.equal(calls[1]!.url.pathname, '/rest/v1/weekly_tasks');
  assert.equal(calls[1]!.url.searchParams.get('week_start'), 'eq.2026-10-26');
});

test('a failed second page rejects the whole read instead of returning an incomplete task count', async () => {
  const { service } = fixture((url) => {
    if (url.pathname.includes('/token')) return Response.json(token());
    if (url.searchParams.has('id')) return new Response('', { status: 503 });
    return Response.json(Array.from({ length: 500 }, (_, n) => task(n + 1)));
  });
  await service.login({ username: 'alice', password: 'test', remember: false });
  await assert.rejects(service.list('pending'), /读取任务失败/);
});

test('restored expired session refreshes once across simultaneous reads, and logout cannot be undone by refresh', async () => {
  const { service, setStored, calls, saves } = fixture((url) => Response.json(url.pathname.includes('/token') ? token('rotated-access', 'rotated-refresh') : []));
  setStored({ accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: now.getTime() - 1000, userId, username: 'alice', remember: true });
  await service.restore();
  await Promise.all([service.list('today'), service.list('pending'), service.logout()]);
  assert.equal(calls.filter((call) => call.url.pathname.includes('/token')).length, 1);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).refresh_token, 'old-refresh');
  assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer rotated-access');
  assert.equal((saves[0] as { refreshToken: string }).refreshToken, 'rotated-refresh');
  assert.equal(saves.at(-1), null);
  assert.equal(service.status().connected, false);
  await assert.rejects(service.list('today'), /先.*连接/);
});

test('revoked refresh clears remembered session, but transient network failures keep it retryable', async () => {
  for (const offline of [false, true]) {
    const { service, setStored, saves } = fixture(() => {
      if (offline) throw new TypeError('offline');
      return new Response('', { status: 400 });
    });
    setStored({ accessToken: 'expired', refreshToken: 'revoked', expiresAt: 0, userId, username: 'alice', remember: true });
    await service.restore();
    await assert.rejects(service.list('today'), offline ? /网络/ : /登录已失效/);
    assert.equal(service.status().connected, offline);
    assert.deepEqual(saves, offline ? [] : [null]);
  }
});

test('401 reads retry with a refreshed token without hiding an authorization failure as an empty list', async () => {
  let reads = 0;
  const { service } = fixture((url) => {
    if (url.pathname.includes('/token')) return Response.json(token());
    return ++reads === 1 ? new Response('', { status: 401 }) : Response.json([task()]);
  });
  await service.login({ username: 'alice', password: 'test', remember: false });
  assert.equal((await service.list('today')).items.length, 1);
  assert.equal(reads, 2);
});

test('summaries preserve actual counts, show priority, and cap chat output without dropping the panel list', () => {
  const snapshot = { view: 'today' as const, date: '2026-10-26', fetchedAt: now.toISOString(), items: Array.from({ length: 7 }, (_, index) => ({
    id: id(index + 1), name: `任务 ${index + 1}`, completed: index === 6, priority: 'high' as const, createdAt: now.toISOString(), reminderAt: null,
  })) };
  const reply = formatTaskListReply(snapshot);
  assert.match(reply, /共 7 项，已完成 1 项，未完成 6 项/);
  assert.match(reply, /高优先级/);
  assert.match(reply, /还有 1 项/);
  assert.doesNotMatch(reply, /任务 6/);
  assert.equal(snapshot.items.length, 7);
});
