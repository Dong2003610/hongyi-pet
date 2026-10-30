import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskListChat, localTaskCommand } from '../../src/main/task-list-chat';
import { TaskCompanion, draftWeeklyPlan } from '../../src/main/task-companion';
import { TaskListService, taskListDate } from '../../src/main/task-list';
import { clampPetBounds, snapPetBounds } from '../../src/main/pet-placement';
import { localCompanionIntent, taskReminderTime, validateCompanionIntent } from '../../src/main/task-chat-intents';
import type { LinkedTask, TaskListCreateInput, TaskListUpdateInput } from '../../src/shared/contracts';
import { carryTaskId } from '../../src/main/task-rules';

const date = '2026-10-22';
const item = (n = 1, name = '写报告'): LinkedTask => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, priority: 'medium', completed: false, createdAt: `${date}T01:00:00Z`, reminderAt: null, elapsedSeconds: 0 });
function fixture(items = [item()]) {
  let revision = 1; let connected = true; let time = Date.parse(`${date}T01:00:00Z`); let mono = 0;
  let interpret: ((text: string) => Promise<unknown>) | undefined;
  let lostAt = 0; let creates = 0;
  const writes: TaskListCreateInput[] = []; const times: number[] = [];
  const check = (expected?: number) => { if (!connected || expected !== revision) throw new Error('账号已切换'); };
  const service = {
    accountKey: () => connected ? '00000000-0000-4000-8000-000000000099' : undefined,
    accountRevision: () => revision, status: () => ({ connected }),
    list: async (view: string, expected: number, day?: string) => { check(expected); return { view, date: day ?? date, fetchedAt: new Date(time).toISOString(), items: structuredClone(items.filter((task) => view === 'pending' ? !task.completed : !day || taskListDate(new Date(task.createdAt)) === day)) }; },
    getDaily: async (id: string, expected: number) => { check(expected); const task = items.find((task) => task.id === id); if (!task) throw new Error('任务不存在'); return { ...task }; },
    rollover: async (day: string, expected: number) => { check(expected); return items.filter((task) => !task.completed && taskListDate(new Date(task.createdAt)) < day && !items.some((copy) => copy.id === carryTaskId(task.id, day))).map((task) => ({ id: carryTaskId(task.id, day), kind: 'daily', name: task.name, priority: task.priority, date: day })); },
    saveElapsed: async (id: string, total: number, expected: number) => { check(expected); times.push(total); const task = items.find((task) => task.id === id)!; task.elapsedSeconds = Math.max(task.elapsedSeconds ?? 0, total); return { ...task }; },
    create: async (input: TaskListCreateInput, expected: number) => {
      check(expected); creates++; writes.push({ ...input });
      let task = items.find((task) => task.id === input.id);
      if (!task) { task = { ...item(), ...input, createdAt: `${input.date}T01:00:00Z`, reminderAt: input.reminderAt ?? null }; items.push(task); }
      if (creates === lostAt) throw new Error('保存后响应丢失');
      return { ...task };
    },
    update: async (input: TaskListUpdateInput, expected: number) => { check(expected); const task = items.find((task) => task.id === input.id)!; Object.assign(task, input.patch); return { ...task }; },
  } as unknown as TaskListService;
  const companion = new TaskCompanion(service, { load: async () => null, save: async () => {}, notify: () => {}, now: () => new Date(time), monotonic: () => mono });
  const chat = new TaskListChat(service, { companion, now: () => new Date(time), plan: (input) => draftWeeklyPlan(input), interpret: async (text) => interpret?.(text) });
  return { chat, service, companion, items, writes, times, advance(ms: number) { time += ms; mono += ms; }, switch() { revision++; }, logout() { connected = false; revision++; },
    ai(fn: (text: string) => Promise<unknown>) { interpret = fn; }, loseAt(n: number) { lostAt = n; } };
}

test('natural focus chat really starts, pauses, resumes and stops the real timer', async () => {
  const f = fixture();
  assert.match((await f.chat.reply('帮我专注写报告25分钟'))!, /已开始专注/);
  assert.equal(f.companion.status().focus.phase, 'running'); assert.equal(f.companion.status().focus.remaining, 1500);
  f.advance(61_000);
  assert.match((await f.chat.reply('专注还剩多久'))!, /23 分 59 秒/);
  assert.match((await f.chat.reply('暂停一下'))!, /已暂停/);
  assert.equal(f.items[0]!.elapsedSeconds, 61);
  f.advance(500_000);
  assert.match((await f.chat.reply('继续刚才的专注'))!, /正在专注/);
  f.advance(10_000);
  assert.match((await f.chat.reply('结束计时'))!, /已结束/);
  assert.equal(f.companion.status().focus.phase, 'idle'); assert.equal(f.items[0]!.elapsedSeconds, 71);
});

test('numbered query context supports half-hour focus, and no-name start asks for selection', async () => {
  const f = fixture([item(), item(2, '读书')]);
  await f.chat.reply('今天有哪些任务');
  assert.match((await f.chat.reply('给第一个任务开个半小时番茄钟'))!, /已开始专注/);
  assert.equal(f.companion.status().focus.remaining, 1800);
  await f.chat.reply('结束计时');
  assert.match((await f.chat.reply('开始专注计时25分钟'))!, /哪项任务/);
  assert.equal(f.companion.status().focus.phase, 'idle');
  assert.match((await f.chat.reply('第2项'))!, /读书/);
  assert.equal(f.companion.status().focus.taskId, item(2).id);
});

test('duplicate/fuzzy task names require confirmation; missing/completed/invalid durations never start', async () => {
  const f = fixture([item(), item(2)]);
  assert.match((await f.chat.reply('专注写报告一小时'))!, /请选择/);
  assert.equal(f.companion.status().focus.phase, 'idle');
  await f.chat.reply('取消');
  assert.match((await f.chat.reply('专注写报告200分钟'))!, /1～180/);
  assert.match((await f.chat.reply('专注不存在25分钟'))!, /没有找到/);
  f.items[0]!.completed = true; f.items.splice(1);
  assert.match((await f.chat.reply('专注写报告25分钟'))!, /已完成/);
  assert.equal(f.companion.status().focus.phase, 'idle');
});

test('negative, hypothetical and quoted focus instructions do not execute', async () => {
  const f = fixture();
  for (const text of ['不要专注写报告25分钟', '请帮我不要开启专注', '如果专注写报告25分钟', '怎么开始专注', '专注写报告25分钟吗？', '他说“专注写报告25分钟”']) {
    assert.doesNotMatch((await f.chat.reply(text)) ?? '', /已开始专注/); assert.equal(f.companion.status().focus.phase, 'idle', text);
  }
  const named = fixture([item(1, '识别图片')]);
  assert.match((await named.chat.reply('专注识别图片25分钟'))!, /已开始专注/);
});

test('already queued chat requests cannot execute on a later account', async () => {
  const f = fixture(); let release!: (value: unknown) => void;
  f.ai(async () => new Promise((resolve) => { release = resolve; }));
  const first = f.chat.reply('写报告这件事给我启动25分钟专注吧');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queued = f.chat.reply('添加任务：读书');
  f.switch(); release(undefined);
  assert.match((await first)!, /账号已切换/);
  assert.match((await queued)!, /账号已切换/); assert.equal(f.writes.length, 0);
});

test('restricted AI resolves free-form focus but cannot substitute task, duration, IDs or switch account', async () => {
  const f = fixture();
  f.ai(async () => ({ type: 'focus', action: 'start', target: '写报告', minutes: 30, id: 'untrusted' }));
  assert.match((await f.chat.reply('写报告这件事给我启动半小时专注吧'))!, /已开始专注/);
  assert.equal(f.companion.status().focus.taskId, item().id);
  await f.chat.reply('结束计时');
  assert.equal(validateCompanionIntent({ type: 'focus', action: 'start', target: '读书', minutes: 30 }, '专注写报告半小时'), undefined);
  assert.equal(validateCompanionIntent({ type: 'focus', action: 'start', target: '写报告', minutes: 180 }, '专注写报告半小时'), undefined);
  f.ai(async () => { f.switch(); return { type: 'focus', action: 'start', target: '写报告', minutes: 25 }; });
  assert.match((await f.chat.reply('写报告这件事给我启动25分钟专注吧'))!, /账号已切换/); assert.equal(f.companion.status().focus.phase, 'idle');
});

test('focus selection and queued companion actions cannot cross account revisions or expiry', async () => {
  const f = fixture([item(), item(2)]);
  await f.chat.reply('专注写报告25分钟'); f.switch();
  assert.match((await f.chat.reply('第1项'))!, /失效/);
  await f.chat.reply('专注写报告25分钟'); f.advance(301_000);
  assert.match((await f.chat.reply('第1项'))!, /失效/);
  await assert.rejects(f.companion.focus({ action: 'start', id: item().id, minutes: 25 }, f.service.accountRevision() - 1), /账号已切换/);
});

test('chat goal breakdown previews only, then confirmation adds with stable UUIDs across lost responses', async () => {
  const f = fixture();
  await f.chat.reply('专注写报告25分钟');
  assert.match((await f.chat.reply('帮我拆解周目标：完成报告'))!, /预览/); assert.equal(f.writes.length, 0);
  assert.match((await f.chat.reply('暂停一下'))!, /已暂停/); assert.equal(f.writes.length, 0, 'preview cannot block timer controls');
  f.loseAt(2);
  assert.match((await f.chat.reply('确认添加'))!, /重试/); assert.equal(f.writes.length, 2);
  assert.match((await f.chat.reply('重试'))!, /已将 5 项/);
  assert.equal(f.items.length, 6); assert.equal(f.writes[1]!.id, f.writes[2]!.id);
  assert.deepEqual(f.writes[1], f.writes[2]);
  await f.chat.reply('确认添加'); assert.equal(f.items.length, 6);
});

test('common explicit focus does not wait on an online AI request', async () => {
  const f = fixture(); let called = 0;
  f.ai(async () => { called++; throw new Error('AI offline'); });
  assert.match((await f.chat.reply('帮我专注写报告25分钟'))!, /已开始专注/); assert.equal(called, 0);
});

test('rollover explains copies, previews before writes, and cancel/stale account do not save', async () => {
  const f = fixture();
  assert.match((await f.chat.reply('今天没做完的明天再做'))!, /创建副本/); assert.equal(f.writes.length, 0);
  await f.chat.reply('取消'); assert.equal(f.items.length, 1);
  await f.chat.reply('今天没做完的明天再做'); f.switch();
  assert.match((await f.chat.reply('确认添加'))!, /失效/); assert.equal(f.writes.length, 0);
  await f.chat.reply('今天没做完的明天再做');
  assert.match((await f.chat.reply('确认添加'))!, /已将 1 项/);
  assert.equal(f.items.length, 2); assert.equal(f.items[0]!.completed, false);
  assert.equal(f.writes[0]!.date, '2026-10-23');
});

test('briefings, desktop reminder consent and scheduled reports all work from chat', async () => {
  const f = fixture();
  await f.chat.reply('到点提醒是开启的吗'); assert.equal(f.companion.status().preferences.reminders, false);
  await f.chat.reply('帮我开启到点提醒好吗？'); assert.equal(f.companion.status().preferences.reminders, true);
  assert.match((await f.chat.reply('总结一下今天完成得怎么样'))!, /晚间复盘/);
  assert.match((await f.chat.reply('开启到点提醒'))!, /到点提醒开启/);
  assert.equal(f.companion.status().preferences.reminders, true);
  await f.chat.reply('每天早上九点给我简报'); assert.equal(f.companion.status().preferences.morningTime, '09:00'); assert.equal(f.companion.status().preferences.morning, true);
  await f.chat.reply('把晚间复盘关掉'); assert.equal(f.companion.status().preferences.evening, false);
  await f.chat.reply('设置免打扰23:00到08:30'); assert.equal(f.companion.status().preferences.quietStart, '23:00');
  assert.match((await f.chat.reply('今天的复盘呢？'))!, /晚间复盘/);
});

test('natural reminder creates/updates real task fields, never promises disabled delivery', async () => {
  const f = fixture();
  assert.match((await f.chat.reply('明天下午三点提醒我交报告'))!, /尚未开启/);
  assert.equal(f.writes[0]!.name, '交报告'); assert.equal(f.writes[0]!.reminderAt, '2026-10-23T07:00:00.000Z');
  await f.chat.reply('把写报告的提醒改为明天15:30'); assert.equal(f.items[0]!.reminderAt, '2026-10-23T07:30:00.000Z');
  await f.chat.reply('取消写报告的提醒'); assert.equal(f.items[0]!.reminderAt, null);
  for (const text of ['明天三点提醒我读书', '今天早上八点提醒我读书', '明天25:00提醒我读书', '每天9:00提醒我读书']) assert.match((await f.chat.reply(text))!, /没有设置提醒/);
});

test('free-form task assignment is AI-parsed and validates the title against the original request', async () => {
  const f = fixture();
  f.ai(async () => ({ type: 'create', kind: 'daily', name: '交报告', date, priority: 'medium' }));
  assert.match((await f.chat.reply('明天我得交报告，帮我记到清单里'))!, /已添加/); assert.equal(f.writes[0]!.date, '2026-10-23');
  f.ai(async () => ({ type: 'create', kind: 'daily', name: '无关标题', date, priority: 'high' }));
  assert.doesNotMatch((await f.chat.reply('把读书加到清单'))!, /已添加/); assert.equal(f.writes.length, 1);
  assert.equal(localTaskCommand('添加任务：专注练习', new Date(`${date}T01:00:00Z`))?.type, 'create');
});

test('pet-specific left allowance is small, scale aware, and preserves artwork and other edges', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  for (const size of [110, 132, 176, 220, 264, 330]) {
    const result = clampPetBounds({ x: -3000, y: 500, width: size, height: size }, area);
    assert.ok(result.x < area.x); assert.ok(result.x + size * 62 / 512 > area.x, 'opaque art stays inside screen');
    assert.deepEqual(snapPetBounds({ ...result, x: result.x + 5 }, area), result);
    assert.equal(result.width, size); assert.equal(result.y, 500);
    const right = clampPetBounds({ ...result, x: 4000, y: 4000 }, area);
    assert.equal(right.x + size, 0); assert.equal(right.y + size, 1080);
  }
});

test('Chinese focus durations and reminder timestamps use explicit Shanghai times', () => {
  assert.deepEqual(localCompanionIntent('专注写报告三十五分钟'), { type: 'focus', action: 'start', target: '写报告', minutes: 35 });
  assert.equal(taskReminderTime('下午三点半', '2026-10-23', new Date(`${date}T01:00:00Z`)), '2026-10-23T07:30:00.000Z');
});

test('briefing numbers feed actual focus and reminder actions, not an older query', async () => {
  const f = fixture([item(), item(2, '回归分配问题'), item(3, '交报告')]);
  await f.chat.reply('今天有哪些任务');
  f.items[0]!.completed = true;
  assert.match((await f.chat.reply('每日简报'))!, /1\. 回归分配问题/);
  assert.match((await f.chat.reply('给第二项任务开个半小时番茄钟'))!, /交报告/);
  assert.equal(f.companion.status().focus.taskId, item(3).id);
  await f.chat.reply('结束计时');
  assert.match((await f.chat.reply('把第一项任务的提醒改为明天15:30'))!, /回归分配问题.*已设置到点提醒/);
  assert.equal(f.items[1]!.reminderAt, '2026-10-23T07:30:00.000Z');
});

test('fuzzy focus candidate accepts task-suffixed full follow-up and starts only the selected task', async () => {
  const f = fixture([item(1, '回归分配问题A'), item(2, '回归分配问题B')]);
  assert.match((await f.chat.reply('专注回归分配问题25分钟'))!, /找到 2 项/);
  assert.equal(f.companion.status().focus.phase, 'idle');
  assert.match((await f.chat.reply('专注第二项任务25分钟'))!, /回归分配问题B/);
  assert.equal(f.companion.status().focus.taskId, item(2).id);
});
