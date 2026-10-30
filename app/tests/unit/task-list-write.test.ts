import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskListService, taskListDate } from '../../src/main/task-list';
import { localTaskCommand, resolveTaskDate, TaskListChat } from '../../src/main/task-list-chat';
import { cleanTaskTarget, rankTaskTargets, taskOrdinal } from '../../src/main/task-targets';

const user = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clock = new Date('2026-10-25T16:01:00Z');
type Row = { id: string; user_id: string; name: string; priority: string; completed: boolean; created_at: string; updated_at: string; completed_at?: string | null; week_start?: string; elapsed_seconds?: number; reminder_at?: string | null; reminder_method?: string | null };
const row = (n: number, name = '交报告'): Row => ({ id: id(n), user_id: user, name, priority: 'medium', completed: false, created_at: clock.toISOString(), updated_at: clock.toISOString() });

async function fixture(initial: Row[] = []) {
  const rows = initial.map((item) => ({ ...item }));
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let lostResponse = false;
  let writeFailure = false;
  let time = clock.getTime();
  const service = new TaskListService({
    url: 'https://example.supabase.co', publicKey: 'test-public', load: async () => null, save: async () => {}, canRemember: () => true, now: () => new Date(time),
    fetch: (async (target: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(target)); calls.push({ url, init });
      if (url.pathname.includes('/token')) return Response.json({ access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600, user: { id: user } });
      const params = url.searchParams;
      const selected = () => rows.filter((item) => {
        if (params.has('user_id') && params.get('user_id') !== `eq.${item.user_id}`) return false;
        if (params.has('id') && params.get('id') !== `eq.${item.id}`) return false;
        if (params.has('completed') && params.get('completed') !== `eq.${item.completed}`) return false;
        if (params.has('created_at') && taskListDate(new Date(item.created_at)) !== taskListDate(new Date(params.get('created_at')!.slice(4)))) return false;
        if (params.has('week_start') && params.get('week_start') !== `eq.${item.week_start}`) return false;
        if (params.has('updated_at') && params.get('updated_at') !== `eq.${item.updated_at}`) return false;
        if (params.has('elapsed_seconds') && (item.elapsed_seconds ?? 0) > Number(params.get('elapsed_seconds')!.slice(4))) return false;
        return url.pathname.includes('weekly_tasks') ? Boolean(item.week_start) : !item.week_start;
      });
      if (init.method === 'POST') {
        if (writeFailure) return new Response('', { status: 503 });
        const value = JSON.parse(String(init.body));
        if (rows.some((item) => item.id === value.id)) return Response.json([]);
        const saved = { ...value, updated_at: new Date(++time).toISOString() } as Row;
        rows.push(saved);
        if (lostResponse) { lostResponse = false; throw new TypeError('response lost after commit'); }
        return Response.json([saved]);
      }
      if (init.method === 'PATCH') {
        if (writeFailure) return new Response('', { status: 503 });
        const updated = selected();
        for (const item of updated) Object.assign(item, JSON.parse(String(init.body)), { updated_at: new Date(++time).toISOString() });
        return Response.json(updated);
      }
      return Response.json(selected());
    }) as typeof fetch,
  });
  await service.login({ username: 'demo', password: 'test', remember: false });
  let changed = 0;
  const chat = new TaskListChat(service, { now: () => new Date(time), changed: () => { changed++; } });
  return { service, chat, rows, calls, changed: () => changed, loseResponse: () => { lostResponse = true; }, failWrites: () => { writeFailure = true; }, advance: (ms: number) => { time += ms; } };
}

test('local command parsing preserves task names and resolves dates using Shanghai calendar', () => {
  assert.deepEqual(localTaskCommand('帮我记一下，明天交报告，优先级高', clock), { type: 'create', kind: 'daily', name: '交报告', date: '2026-10-27', priority: 'high' });
  assert.equal(localTaskCommand('添加任务：下周一交报告', clock)?.date, '2026-11-02');
  assert.equal(resolveTaskDate('后天', clock), '2026-10-28');
  assert.equal(resolveTaskDate('2026-2-30', clock), undefined);
  assert.equal(localTaskCommand('新增本周计划：交报告', clock)?.kind, 'weekly');
  assert.equal(localTaskCommand('新增本周计划：交报告', clock)?.type, 'create');
  assert.equal(localTaskCommand('我已经完成了交报告', clock)?.type, 'update');
  for (const text of ['添加一点盐', '不要把报告标记完成', '如果报告完成了', '报告完成了吗', '怎么新增任务']) assert.equal(localTaskCommand(text, clock), undefined, text);
});

test('task creation separates priority and task wrappers across natural word orders', () => {
  const cases = [
    ['新增高优先级任务：XXXXX', 'XXXXX', 'high', '2026-10-26'],
    ['新增中优先级任务：XXXXX', 'XXXXX', 'medium', '2026-10-26'],
    ['新增低优先级任务：XXXXX', 'XXXXX', 'low', '2026-10-26'],
    ['帮我新增一个高优先级任务：提交报告', '提交报告', 'high', '2026-10-26'],
    ['帮我新增提交报告高优先级任务', '提交报告', 'high', '2026-10-26'],
    ['麻烦你进行新增一个高优先级任务，提交报告', '提交报告', 'high', '2026-10-26'],
    ['新增任务：提交报告，优先级设置为高', '提交报告', 'high', '2026-10-26'],
    ['帮我新增明天的高优先级任务：提交报告', '提交报告', 'high', '2026-10-27'],
    ['帮我添加一个任务，名称为提交报告，优先级设为高', '提交报告', 'high', '2026-10-26'],
    ['请帮我新增一项低优先级的任务：整理资料', '整理资料', 'low', '2026-10-26'],
    ['新建一个中优先级待办：读书', '读书', 'medium', '2026-10-26'],
    ['帮我新增高优先级的提交报告任务', '提交报告', 'high', '2026-10-26'],
    ['帮我新增任务：提交报告，设置为高优先级', '提交报告', 'high', '2026-10-26'],
    ['新增高优先级本周计划：发布桌宠', '发布桌宠', 'high', '2026-10-26'],
  ];
  for (const [text, name, priority, date] of cases) {
    const command = localTaskCommand(text!, clock);
    assert.equal(command?.type, 'create', text);
    if (command?.type === 'create') { assert.equal(command.name, name, text); assert.equal(command.priority, priority, text); assert.equal(command.date, date, text); }
  }
  assert.equal(localTaskCommand(cases.at(-1)![0]!, clock)?.kind, 'weekly');
});

test('creation preserves quoted priority words in titles and does not invent an unnamed task', async () => {
  const quoted = localTaskCommand('新增任务：“高优先级任务说明”，优先级低', clock);
  assert.equal(quoted?.type === 'create' && quoted.name, '高优先级任务说明');
  assert.equal(quoted?.type === 'create' && quoted.priority, 'low');
  const f = await fixture();
  for (const text of ['新增一个高优先级任务', '帮我新增任务，优先级高', '不要新增高优先级任务：提交报告', '怎么新增高优先级任务', '如果新增高优先级任务：提交报告']) {
    assert.doesNotMatch((await f.chat.reply(text)) ?? '', /已添加/); assert.equal(f.rows.length, 0, text);
  }
});

test('natural high-priority creation reaches the backend with a clean title and correct date', async () => {
  const f = await fixture();
  const reply = await f.chat.turn('麻烦你帮我新增一个明天的高优先级任务：提交报告');
  assert.match(reply?.content ?? '', /已添加任务/); assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0]!.name, '提交报告'); assert.equal(f.rows[0]!.priority, 'high');
  assert.equal(taskListDate(new Date(f.rows[0]!.created_at)), '2026-10-27');
  assert.match(reply?.cards?.[0]?.detail ?? '', /高优先级/);
  const exact = await f.chat.turn('新增高优先级任务：XXXXX');
  assert.match(exact?.content ?? '', /已添加任务/);
  assert.equal(f.rows[1]!.name, 'XXXXX'); assert.equal(f.rows[1]!.priority, 'high');
});

test('focus service writes are user-scoped, monotonic and limited to elapsed_seconds', async () => {
  const f = await fixture([{ ...row(1), elapsed_seconds: 300 }]);
  const current = await f.service.getDaily(id(1), f.service.accountRevision());
  assert.equal(current.elapsedSeconds, 300);
  const higher = await f.service.saveElapsed(id(1), 100, f.service.accountRevision());
  assert.equal(higher.elapsedSeconds, 300); assert.equal(f.rows[0]!.elapsed_seconds, 300);
  await f.service.saveElapsed(id(1), 310, f.service.accountRevision());
  assert.equal(f.rows[0]!.elapsed_seconds, 310);
  for (const call of f.calls.filter((entry) => entry.init.method === 'PATCH')) {
    assert.equal(call.url.searchParams.get('user_id'), `eq.${user}`);
    assert.equal(call.url.searchParams.get('id'), `eq.${id(1)}`);
    assert.deepEqual(Object.keys(JSON.parse(String(call.init.body))), ['elapsed_seconds']);
    assert.match(call.url.searchParams.get('elapsed_seconds')!, /^lte\./);
  }
  await assert.rejects(f.service.saveElapsed(id(1), -1, f.service.accountRevision()));
  await assert.rejects(f.service.saveElapsed(id(1), 400, f.service.accountRevision() - 1));
});

test('reminder create/edit uses the same daily task fields as website and weekly tasks cannot receive reminders', async () => {
  const f = await fixture();
  const input = { id: id(1), kind: 'daily', name: '提醒测试', priority: 'medium', date: taskListDate(clock), reminderAt: '2026-10-26T02:00:00.000Z' };
  const saved = await f.service.create(input, f.service.accountRevision());
  assert.equal(saved.reminderAt, input.reminderAt); assert.equal(f.rows[0]!.reminder_method, 'dialog');
  await f.service.update({ id: id(1), kind: 'daily', patch: { reminderAt: null } }, f.service.accountRevision());
  assert.equal(f.rows[0]!.reminder_at, null); assert.equal(f.rows[0]!.reminder_method, null);
  assert.equal('reminderAt' in f.rows[0]!, false, 'public IPC name is mapped, never written as an unknown column');
  await assert.rejects(f.service.update({ id: id(1), kind: 'weekly', patch: { reminderAt: input.reminderAt } }));
  await assert.rejects(f.service.create({ ...input, kind: 'weekly' }));
});

test('creates tomorrow task with trusted account, correct date and defaults; announces success only after save', async () => {
  const { chat, rows, calls, changed } = await fixture();
  assert.match((await chat.reply('帮我记一下，明天交报告，优先级高'))!, /已添加任务/);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.user_id, user); assert.equal(rows[0]!.name, '交报告');
  assert.equal(taskListDate(new Date(rows[0]!.created_at)), '2026-10-27');
  assert.equal(rows[0]!.priority, 'high'); assert.equal(rows[0]!.completed, false);
  assert.equal(changed(), 1);
  const post = calls.find((call) => call.init.method === 'POST' && call.url.pathname.includes('/rest/'))!;
  assert.match((post.init.headers as Record<string, string>).Prefer!, /ignore-duplicates/);
  assert.equal(post.url.searchParams.get('on_conflict'), 'id');
});

test('lost create response can be retried with exactly the same id and never overwrites an existing task', async () => {
  const { chat, rows, calls, loseResponse } = await fixture();
  loseResponse();
  assert.match((await chat.reply('添加任务：交报告'))!, /重试/);
  assert.equal(rows.length, 1);
  assert.match((await chat.reply('重试'))!, /已添加任务/);
  assert.equal(rows.length, 1);
  const requests = calls.filter((call) => call.init.method === 'POST' && call.url.pathname.includes('/rest/'));
  assert.equal(JSON.parse(String(requests[0]!.init.body)).id, JSON.parse(String(requests[1]!.init.body)).id);
});

test('completes exact task, can undo completion, rename and change priority', async () => {
  const { chat, rows, calls } = await fixture([row(1)]);
  assert.match((await chat.reply('把交报告标记完成'))!, /已标记完成/);
  assert.equal(rows[0]!.completed, true); assert.ok(rows[0]!.completed_at);
  assert.match((await chat.reply('把交报告标记为未完成'))!, /已恢复未完成/);
  assert.equal(rows[0]!.completed_at, null);
  assert.match((await chat.reply('把交报告优先级改为高'))!, /优先级已改为高/);
  assert.equal(rows[0]!.priority, 'high');
  assert.match((await chat.reply('把交报告改名为交周报'))!, /已改名/);
  assert.equal(rows[0]!.name, '交周报');
  for (const call of calls.filter((entry) => entry.init.method === 'PATCH')) {
    assert.equal(call.url.searchParams.get('user_id'), `eq.${user}`);
    assert.equal(call.url.searchParams.has('updated_at'), true);
  }
});

test('same-name tasks are not changed until a numbered choice; cancellation makes no write', async () => {
  const { chat, rows, calls } = await fixture([row(1), row(2)]);
  assert.match((await chat.reply('把交报告标记完成'))!, /找到 2 项/);
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
  assert.match((await chat.reply('第2项'))!, /已标记完成/);
  assert.equal(rows[0]!.completed, false); assert.equal(rows[1]!.completed, true);
  await chat.reply('把交报告标记为未完成');
  assert.match((await chat.reply('取消'))!, /已取消/);
  assert.equal(rows[0]!.completed, false);
});

test('fuzzy names require explicit selection even if only one task matches', async () => {
  const { chat, rows } = await fixture([row(1, '写项目报告')]);
  assert.match((await chat.reply('报告写完了'))!, /请选择/);
  assert.equal(rows[0]!.completed, false);
  assert.match((await chat.reply('第1项'))!, /已标记完成/);
  assert.equal(rows[0]!.completed, true);
});

test('stale choice cannot overwrite concurrent edits; expired choices cannot execute', async () => {
  const { chat, rows, advance } = await fixture([row(1), row(2)]);
  await chat.reply('把交报告标记完成');
  rows[0]!.updated_at = new Date(clock.getTime() + 10000).toISOString();
  assert.match((await chat.reply('第1项'))!, /已发生变化/);
  assert.equal(rows[0]!.completed, false);
  advance(6 * 60_000);
  assert.match((await chat.reply('第2项'))!, /失效/);
  assert.equal(rows[1]!.completed, false);
});

test('database failures never report success and unsupported deletes never reach the backend', async () => {
  const { chat, rows, failWrites, changed } = await fixture([row(1)]);
  failWrites();
  const reply = (await chat.reply('把交报告标记完成'))!;
  assert.match(reply, /修改失败/); assert.doesNotMatch(reply, /已标记完成/);
  assert.equal(rows[0]!.completed, false); assert.equal(changed(), 0);
  assert.match((await chat.reply('删除交报告任务'))!, /网页版/);
});

test('service rejects arbitrary columns, another user_id, malformed dates and stale account revisions', async () => {
  const { service, calls } = await fixture();
  const create = { id: id(1), kind: 'daily', name: '测试', date: '2026-10-26', priority: 'medium' };
  await assert.rejects(service.create({ ...create, user_id: id(2) }), /不正确/);
  await assert.rejects(service.create({ ...create, date: '2026-02-30' }), /不正确/);
  await assert.rejects(service.update({ id: id(1), kind: 'daily', patch: { user_id: id(2) } }), /不正确/);
  const previous = service.accountRevision();
  await service.logout(); await service.login({ username: 'demo', password: 'test', remember: false });
  await assert.rejects(service.create(create, previous), /账号已切换/);
  assert.equal(calls.some((call) => call.url.pathname.includes('/rest/')), false);
});

test('AI interpretation cannot commit after an account switch or execute unapproved patch fields', async () => {
  const { service, rows } = await fixture([row(1)]);
  let release!: (value: unknown) => void;
  const chat = new TaskListChat(service, { now: () => clock, interpret: async () => new Promise((resolve) => { release = resolve; }) });
  const pending = chat.reply('把交报告优先级调高');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.logout();
  release({ type: 'update', kind: 'daily', target: '交报告', patch: { priority: 'high' } });
  assert.match((await pending)!, /账号已切换/);
  assert.equal(rows.length, 1);
});

test('free-form requests can use AI while explicit commands stay deterministic and malformed actions do not write', async () => {
  const { service, rows } = await fixture([row(1)]);
  let calls = 0;
  const chat = new TaskListChat(service, { now: () => clock, interpret: async (text) => {
    calls++;
    assert.equal(text, '把交报告优先级调高');
    return { type: 'update', kind: 'daily', target: '交报告', patch: { priority: 'high' } };
  } });
  assert.match((await chat.reply('把交报告优先级调高'))!, /已改为高/);
  assert.equal(rows[0]!.priority, 'high'); assert.equal(calls, 1);
  await chat.reply('把交报告标记完成'); assert.equal(calls, 1);
  const unsafe = new TaskListChat(service, { now: () => clock, interpret: async () => ({ type: 'update', kind: 'daily', target: '交报告', patch: { user_id: id(2), completed: false } }) });
  assert.match((await unsafe.reply('把交报告优先级调高'))!, /补充/);
  assert.equal(rows[0]!.completed, true); assert.equal(rows[0]!.user_id, user);
});

test('query followed by a numbered completion uses displayed ids; tomorrow query uses the requested day', async () => {
  const { chat, rows } = await fixture([row(1), row(2, '买牛奶')]);
  assert.match((await chat.reply('今天有哪些任务'))!, /未完成 2 项/);
  assert.match((await chat.reply('把第2项标记完成'))!, /已标记完成/);
  assert.equal(rows[1]!.completed, true);
  assert.match((await chat.reply('帮我记一下，明天提交周报'))!, /2026-10-27/);
  assert.match((await chat.reply('明天有哪些任务'))!, /提交周报/);
});

test('weekly plans use the weekly table and matching week without changing daily records', async () => {
  const { chat, rows, calls } = await fixture([row(1)]);
  assert.match((await chat.reply('新增本周计划：发布桌宠'))!, /已添加周计划/);
  assert.equal(rows[1]!.week_start, '2026-10-26');
  assert.match((await chat.reply('把周计划发布桌宠标记完成'))!, /已标记完成/);
  assert.equal(rows[0]!.completed, false); assert.equal(rows[1]!.completed, true);
  assert.ok(calls.some((call) => call.url.pathname.endsWith('/weekly_tasks') && call.init.method === 'PATCH'));
});

test('task titles may contain action words and AI cannot substitute an unrelated task target', async () => {
  const { service, chat, rows } = await fixture([row(1, '买牛奶')]);
  assert.match((await chat.reply('添加任务：删除旧缓存'))!, /已添加任务/);
  assert.equal(rows[1]!.name, '删除旧缓存');
  const confused = new TaskListChat(service, { now: () => clock, interpret: async () => ({ type: 'update', kind: 'daily', target: '买牛奶', patch: { priority: 'high' } }) });
  assert.match((await confused.reply('把交报告优先级调高'))!, /补充/);
  assert.equal(rows[0]!.priority, 'medium');
});

test('screenshot priority phrases parse locally, with quote and task suffix cleanup', () => {
  for (const text of ['把第2项任务改为高优先级', '将“把分配问题回归完”任务转为高优先级', '将“把分配的问题回归完”任务转为高优先级']) {
    const command = localTaskCommand(text, clock);
    assert.equal(command?.type, 'update', text);
    if (command?.type === 'update') assert.equal(command.patch.priority, 'high');
  }
  assert.equal(cleanTaskTarget('“把分配的问题回归完”任务'), '把分配的问题回归完');
  assert.equal(cleanTaskTarget('「完成报告」这个任务'), '完成报告');
});

test('ordinals accept task suffixes, Chinese numbers and full-width digits, not digits inside titles', () => {
  for (const [text, expected] of [['第二项任务', 2], ['第3个任务', 3], ['第２条待办', 2], ['第十一项任务', 11], ['第两项任务', 2], ['选择第三条任务', 3]] as const) assert.equal(taskOrdinal(text), expected, text);
  for (const text of ['第2季度报告', '交第3次报告', '第一项和第二项', '第0项任务', '第100项任务']) assert.equal(taskOrdinal(text), undefined, text);
});

test('all ordinal variants refer to the last displayed IDs despite priority/completion reorder', async () => {
  const f = await fixture([row(1, '核对范围'), row(2, '回归分配问题'), row(3, '提交报告')]);
  await f.chat.reply('今天有哪些任务');
  assert.match((await f.chat.reply('把第二项任务改为高优先级'))!, /回归分配问题.*已改为高/);
  assert.equal(f.rows[1]!.priority, 'high'); assert.equal(f.rows[0]!.priority, 'medium');
  assert.match((await f.chat.reply('把第3个任务标记完成'))!, /提交报告.*已标记完成/);
  assert.match((await f.chat.reply('把第三条任务标记为未完成'))!, /提交报告.*已恢复未完成/);
  assert.match((await f.chat.reply('将第2项任务转为低优先级'))!, /回归分配问题.*已改为低/);
  assert.equal(f.rows[1]!.priority, 'low');
});

test('no previous query shows and confirms ordinal task instead of guessing or demanding a full title', async () => {
  const f = await fixture([row(1, '核对范围'), row(2, '回归分配问题'), row(3, '提交报告')]);
  const reply = (await f.chat.reply('把第3个任务改为高优先级'))!;
  assert.match(reply, /尚未修改/); assert.match(reply, /提交报告/);
  assert.equal(f.calls.some((call) => call.init.method === 'PATCH'), false);
  assert.match((await f.chat.reply('第三项任务'))!, /提交报告.*已改为高/);
  assert.equal(f.rows[2]!.priority, 'high');
});

test('screenshot omitted words, reordered keywords and typo find candidates before any write', async () => {
  for (const target of ['把分配问题回归完', '回归分配问题', '把分配的问提回归完']) {
    const f = await fixture([row(1, '把分配的问题回归完'), row(2, '交报告')]);
    assert.match((await f.chat.reply(`将“${target}”任务转为高优先级`))!, /找到 1 项.*请选择/);
    assert.equal(f.rows[0]!.priority, 'medium');
    assert.match((await f.chat.reply('确认'))!, /已改为高/);
    assert.equal(f.rows[0]!.priority, 'high'); assert.equal(f.rows[1]!.priority, 'medium');
  }
});

test('candidate numbering supersedes old query and accepts full follow-up commands', async () => {
  const f = await fixture([row(1, '提交报告'), row(2, '回归分配问题A'), row(3, '回归分配问题B')]);
  await f.chat.reply('今天有哪些任务');
  assert.match((await f.chat.reply('把回归分配问题改为高优先级'))!, /找到 2 项/);
  assert.match((await f.chat.reply('将第二项任务转为低优先级'))!, /回归分配问题B.*已改为低/);
  assert.equal(f.rows[2]!.priority, 'low'); assert.equal(f.rows[1]!.priority, 'medium');
  assert.match((await f.chat.reply('把第1个任务标记完成'))!, /回归分配问题A.*已标记完成/);
});

test('fuzzy matches include unfinished older tasks, and duplicate names on different dates require choice', async () => {
  const yesterday = new Date(clock.getTime() - 86400_000).toISOString();
  const f = await fixture([row(1, '回归登录问题'), { ...row(2, '把分配的问题回归完'), created_at: yesterday }]);
  assert.match((await f.chat.reply('将“把分配问题回归完”任务转为高优先级'))!, /找到 1 项/);
  await f.chat.reply('第1项任务'); assert.equal(f.rows[1]!.priority, 'high');
  const duplicate = await fixture([row(1), { ...row(2), created_at: yesterday }]);
  assert.match((await duplicate.chat.reply('把交报告标记完成'))!, /找到 2 项/);
  assert.equal(duplicate.rows.every((item) => !item.completed), true);
});

test('numbered references expire, reject unseen indexes and never jump to a different date/type', async () => {
  const f = await fixture([row(1), row(2, '回归测试')]);
  await f.chat.reply('今天有哪些任务');
  assert.match((await f.chat.reply('把第3个任务改为高优先级'))!, /只列出了 2 项/);
  assert.match((await f.chat.reply('把明天第2项任务改为高优先级'))!, /不一致/);
  assert.match((await f.chat.reply('把周计划第2项任务改为高优先级'))!, /不一致/);
  f.advance(301_000);
  assert.match((await f.chat.reply('把第二项任务改为高优先级'))!, /失效/);
  assert.equal(f.calls.some((call) => call.init.method === 'PATCH'), false);
});

test('ordinal update inherits the weekly list only when no other kind/date is requested', async () => {
  const f = await fixture([{ ...row(1, '本周交付'), week_start: '2026-10-26' }, row(2, '每日任务')]);
  await f.chat.reply('本周计划是什么');
  assert.match((await f.chat.reply('将第一项任务转为高优先级'))!, /本周交付.*已改为高/);
  assert.equal(f.rows[0]!.priority, 'high'); assert.equal(f.rows[1]!.priority, 'medium');
});

test('quoted title with action words is data, quoted instructions and negations remain non-mutating', async () => {
  const f = await fixture([row(1, '完成报告'), row(2, '第2项任务')]);
  assert.match((await f.chat.reply('将“完成报告”任务转为高优先级'))!, /完成报告.*已改为高/);
  assert.match((await f.chat.reply('把“第2项任务”改为低优先级'))!, /第2项任务.*已改为低/);
  for (const text of ['不要将“完成报告”任务转为低优先级', '他说“把完成报告标记完成”', '如果把“完成报告”任务转为低优先级', '将“完成报告”任务转为低优先级吗？']) await f.chat.reply(text);
  assert.equal(f.rows[0]!.priority, 'high'); assert.equal(f.rows[0]!.completed, false);
});

test('exact matches preserve meaningful symbols and unrelated/too-short names do not get guessed', () => {
  const tasks = [row(1, 'C++基础'), row(2, 'C#基础'), row(3, '交报告')].map((row) => ({ id: row.id, name: row.name, priority: 'medium' as const, completed: false, createdAt: row.created_at, reminderAt: null }));
  assert.equal(rankTaskTargets(tasks, 'C++基础').items[0]!.id, id(1));
  assert.equal(rankTaskTargets(tasks, 'C++基础').items.length, 1);
  assert.equal(rankTaskTargets(tasks, '今天天气').items.length, 0);
  assert.equal(rankTaskTargets(tasks, '报').items.length, 0);
  const versions = [{ ...tasks[0]!, name: '发布v1.2' }, { ...tasks[1]!, name: '发布v12' }];
  assert.deepEqual(rankTaskTargets(versions, '发布v1.2').items.map((item) => item.id), [id(1)]);
});

test('an unmatched title returns actual numbered alternatives instead of fabricating a match', async () => {
  const f = await fixture([row(1, '核对范围'), row(2, '回归分配问题')]);
  assert.match((await f.chat.reply('把不存在的任务改为高优先级'))!, /尚未修改.*当前可选/s);
  assert.match((await f.chat.reply('把第二项任务改为高优先级'))!, /回归分配问题.*已改为高/);
  assert.equal(f.rows[0]!.priority, 'medium'); assert.equal(f.rows[1]!.priority, 'high');
});
