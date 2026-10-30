import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskListService, taskListDate } from '../../src/main/task-list';
import { TaskListChat, localTaskCommand } from '../../src/main/task-list-chat';
import { TaskCompanion, companionDefaults } from '../../src/main/task-companion';
import { personalReminder } from '../../src/main/reminder-chat';
import { carryTaskId } from '../../src/main/task-rules';
import { parseChatHistory } from '../../src/main/data-validation';
import type { ChatMessage } from '../../src/shared/contracts';

const user = '00000000-0000-4000-8000-000000000099';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-29T01:00:00.000Z';
function row(n: number, name = '写报告', order: number | null = null) {
  return { id: id(n), user_id: user, name, priority: 'medium', completed: false, created_at: now, updated_at: now, completed_at: null as string | null,
    reminder_at: null as string | null, reminder_method: null as string | null, elapsed_seconds: 0, sort_order: order };
}
async function fixture(initial = [row(1)]) {
  const rows = structuredClone(initial); let clock = Date.parse(now); let mono = 0; let version = 0; let persisted: unknown;
  const metadata: Record<string, unknown> = {}; let fail = false;
  const service = new TaskListService({ url: 'https://test.invalid', publicKey: 'test-only', load: async () => null, save: async () => {}, canRemember: () => true, now: () => new Date(clock),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input)); const params = url.searchParams;
      if (url.pathname.includes('/token')) return Response.json({ access_token: 'test-only', refresh_token: 'test-refresh', expires_in: 3600, user: { id: user } });
      if (url.pathname === '/auth/v1/user') {
        if (init.method === 'PUT') Object.assign(metadata, JSON.parse(String(init.body)).data);
        return Response.json({ id: user, user_metadata: metadata });
      }
      if (fail) return new Response('', { status: 503 });
      const selected = rows.filter((item) => {
        if (params.get('user_id') && params.get('user_id') !== `eq.${item.user_id}`) return false;
        if (params.get('id')?.startsWith('eq.') && params.get('id') !== `eq.${item.id}`) return false;
        if (params.get('completed') && params.get('completed') !== `eq.${item.completed}`) return false;
        if (params.get('created_at')?.startsWith('gte.') && Date.parse(item.created_at) < Date.parse(params.get('created_at')!.slice(4))) return false;
        if (params.get('and')) { const until = params.get('and')!.slice('(created_at.lt.'.length, -1); if (Date.parse(item.created_at) >= Date.parse(until)) return false; }
        if (params.get('updated_at') && params.get('updated_at') !== `eq.${item.updated_at}`) return false;
        if (params.get('elapsed_seconds') && item.elapsed_seconds > Number(params.get('elapsed_seconds')!.slice(4))) return false;
        return true;
      });
      if (init.method === 'POST') {
        const data = JSON.parse(String(init.body)); if (rows.some((item) => item.id === data.id)) return Response.json([]);
        const saved = { ...row(100), ...data, updated_at: new Date(clock + ++version).toISOString() }; rows.push(saved); return Response.json([saved]);
      }
      if (init.method === 'PATCH') { selected.forEach((item) => Object.assign(item, JSON.parse(String(init.body)), { updated_at: new Date(clock + ++version).toISOString() })); }
      return Response.json(selected);
    }) as typeof fetch });
  await service.login({ username: 'test', password: 'test-only', remember: false });
  const options = { load: async () => structuredClone(persisted), save: async (data: unknown) => { persisted = structuredClone(data); }, now: () => new Date(clock), monotonic: () => mono, notify: () => {} };
  const companion = new TaskCompanion(service, options);
  const chat = new TaskListChat(service, { companion, completed: (item, revision) => companion.completed(item, revision), now: () => new Date(clock) });
  return { rows, metadata, service, companion, chat, advance(ms: number) { clock += ms; mono += ms; }, fail(value: boolean) { fail = value; }, restore: () => new TaskCompanion(service, options) };
}
const action = (message: ChatMessage | undefined, label: string) => message?.cards?.flatMap((card) => card.actions ?? []).find((item) => item.label === label)?.id!;

test('polite requests execute while information questions, negatives and quoted speech do not write', async () => {
  const f = await fixture();
  await f.chat.reply('今天有哪些任务');
  assert.match((await f.chat.reply('帮我把第一项任务改成高优先级可以吗？'))!, /优先级已改为高/);
  assert.equal(f.rows[0]!.priority, 'high');
  for (const text of ['报告完成了吗？', '不要把写报告标记完成', '他说“把写报告标记完成”', '如果把写报告标记完成']) await f.chat.reply(text);
  assert.equal(f.rows[0]!.completed, false);
  assert.match((await f.chat.reply('能帮我专注写报告25分钟吗？'))!, /已开始专注/);
});

test('manual web order is the visible ordinal order, and a selected task supports follow-up date changes and undo', async () => {
  const f = await fixture([row(1, '写报告', 20), row(2, '读书', 10)]);
  const snapshot = await f.service.list('today'); assert.deepEqual(snapshot.items.map((item) => item.id), [id(2), id(1)]);
  f.chat.rememberList(snapshot);
  await f.chat.reply('把第二项任务改成高优先级'); assert.equal(f.rows[0]!.priority, 'high');
  f.chat.select(id(1), 'daily');
  const changed = await f.chat.turn('改到明天'); assert.equal(taskListDate(new Date(f.rows[0]!.created_at)), '2026-10-30');
  const undo = action(changed, '撤销修改'); assert.ok(undo);
  await f.chat.act(undo); assert.equal(taskListDate(new Date(f.rows[0]!.created_at)), '2026-10-29');
  assert.match((await f.chat.act(undo)).content, /失效/);
});

test('undo cannot overwrite a newer edit from another client', async () => {
  const f = await fixture(); const changed = await f.chat.turn('把写报告改为高优先级');
  f.rows[0]!.name = '网页刚刚改名'; f.rows[0]!.updated_at = '2026-10-29T02:00:00.000Z';
  const result = await f.chat.act(action(changed, '撤销修改'));
  assert.match(result.content, /发生变化/); assert.equal(f.rows[0]!.name, '网页刚刚改名'); assert.equal(f.rows[0]!.priority, 'high');
});

test('fuzzy choice cards select a real task and late/account-switched actions cannot execute', async () => {
  const f = await fixture([row(1, '提交销售报告'), row(2, '提交技术报告')]);
  const choice = await f.chat.turn('把报告标记完成'); assert.equal(choice?.cards?.[0]?.kind, 'choice'); assert.equal(f.rows.some((item) => item.completed), false);
  const token = action(choice, '选择这项'); await f.chat.act(token); assert.equal(f.rows.filter((item) => item.completed).length, 1);
  assert.match((await f.chat.act(token)).content, /失效/);
  const query = await f.chat.turn('今天有哪些任务'); const token2 = action(query, '完成');
  await f.service.logout(); assert.match((await f.chat.act(token2)).content, /失效/);
});

test('relative reminder crosses Shanghai midnight and matching task receives reminder instead of a duplicate', async () => {
  const parsed = localTaskCommand('十分钟后提醒我喝水', new Date('2026-10-29T15:55:00Z'));
  assert.equal(parsed?.type === 'create' && parsed.date, '2026-10-30');
  const f = await fixture(); await f.chat.reply('十分钟后提醒我写报告');
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0]!.reminder_at, '2026-10-29T01:10:00.000Z');
});

test('personal recurring reminders are local in either login state, while connected one-shot reminders use tasks', () => {
  assert.equal(personalReminder('每天下午三点提醒我喝水', new Date(now), true)?.repeat, 'daily');
  assert.equal(personalReminder('工作日早上九点提醒我喝水', new Date('2026-10-30T02:00:00Z'), true)?.dueAt, '2026-11-02T01:00:00.000Z');
  assert.equal(personalReminder('十分钟后提醒我喝水', new Date(now), true), undefined);
  assert.equal(personalReminder('十分钟后提醒我喝水', new Date(now), false)?.dueAt, '2026-10-29T01:10:00.000Z');
});

test('free focus works without login, persists paused on restart, and shares pause/resume/finish semantics', async () => {
  const f = await fixture(); await f.service.logout();
  assert.match((await f.chat.reply('自由专注25分钟'))!, /已开始自由专注/); f.advance(10000);
  await f.chat.reply('暂停一下'); assert.equal(f.companion.status().focus.seconds, 10);
  const restored = f.restore(); await restored.restore(); assert.equal(restored.status().focus.phase, 'paused'); assert.equal(restored.status().focus.free, true);
  await f.chat.reply('继续专注'); f.advance(10000); await f.chat.reply('结束计时'); assert.equal(f.companion.status().focus.phase, 'idle');
});

test('carrying uses website IDs, respects cancellation and an already completed target copy', async () => {
  const f = await fixture([row(1), row(2, '读书')]);
  f.metadata[`dtl_carry_cancel_v2_${id(2)}`] = true;
  const first = await f.service.rollover('2026-10-30'); assert.equal(first.length, 1); assert.equal(first[0]!.id, carryTaskId(id(1), '2026-10-30'));
  await f.service.create(first[0]);
  await f.service.update({ id: first[0]!.id, kind: 'daily', patch: { completed: true } });
  assert.equal((await f.service.rollover('2026-10-30')).length, 0);
});

test('one notification channel is stored at the account and switching to web disables desktop delivery', async () => {
  const f = await fixture(); await f.companion.configure({ ...companionDefaults, reminders: true });
  assert.equal(f.metadata.dtl_reminder_owner_v1, 'desktop');
  f.metadata.dtl_reminder_owner_v1 = 'web'; await f.companion.tick(); assert.equal(f.companion.status().preferences.reminders, false);
});

test('a live web focus blocks desktop start; expired claims recover and pausing releases the claim', async () => {
  const f = await fixture(); f.metadata.dtl_focus_v1 = { owner: 'web', client: 'test-web', phase: 'running', expiresAt: Date.parse(now) + 90000 };
  await assert.rejects(f.companion.focus({ action: 'start', id: id(1), minutes: 25 }), /网页正在专注/);
  f.advance(91000); await f.companion.focus({ action: 'start', id: id(1), minutes: 25 });
  assert.equal((f.metadata.dtl_focus_v1 as { owner: string }).owner, 'desktop');
  f.advance(10000); await f.companion.focus({ action: 'pause' }); assert.equal(f.metadata.dtl_focus_v1, null);
});

test('failed changes return an explicit uncertain result with a read-only status action', async () => {
  const f = await fixture(); f.fail(true); const reply = await f.chat.turn('把写报告标记完成');
  assert.doesNotMatch(reply?.content ?? '', /已标记完成/); assert.equal(reply?.cards?.[0]?.kind, 'error'); assert.equal(f.rows[0]!.completed, false);
});

test('clicking a failed task update keeps the read-only reconciliation card and selected context', async () => {
  const f = await fixture(); const query = await f.chat.turn('今天有哪些任务');
  const selected = await f.chat.act(action(query, '选中这项')); assert.equal(selected.activeTaskName, '写报告');
  f.fail(true); const failed = await f.chat.act(action(query, '完成'));
  assert.match(failed.cards?.[0]?.title ?? '', /尚未确认/);
  assert.ok(action(failed, '查看当前状态')); assert.equal(action(failed, '重试'), undefined);
});

test('suspend, natural round end and task completion release focus ownership immediately', async () => {
  const f = await fixture([row(1), row(2, '读书')]);
  await f.companion.focus({ action: 'start', id: id(1), minutes: 1 });
  await f.companion.suspend(); assert.equal(f.metadata.dtl_focus_v1, null);
  await f.companion.focus({ action: 'resume' }); f.advance(60000); await f.companion.tick();
  assert.equal(f.metadata.dtl_focus_v1, null); assert.equal(f.companion.status().focus.phase, 'paused');
  await f.companion.focus({ action: 'stop' });
  await f.companion.focus({ action: 'start', id: id(1), minutes: 25 }); f.advance(10000);
  const completed = await f.service.update({ id: id(1), kind: 'daily', patch: { completed: true } });
  await f.companion.completed(completed, f.service.accountRevision());
  assert.equal(f.companion.status().focus.phase, 'idle'); assert.equal(f.metadata.dtl_focus_v1, null);
  await f.companion.focus({ action: 'start', id: id(2), minutes: 25 });
  assert.equal(f.companion.status().focus.name, '读书');
});

test('history keeps task receipts but strips executable actions, including after restart', () => {
  const restored = parseChatHistory([{ role: 'assistant', source: 'task', content: '已保存', cards: [{ kind: 'task', title: '<b>报告</b>', detail: '已同步', state: 'saved', actions: [{ id: 'expired', label: '完成' }] }] }]);
  assert.equal(restored[0]!.source, 'task'); assert.equal(restored[0]!.cards?.[0]?.title, '<b>报告</b>'); assert.equal(restored[0]!.cards?.[0]?.actions, undefined);
});
