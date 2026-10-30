import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskCompanion, companionDefaults, companionPreferences, draftWeeklyPlan, isQuiet } from '../../src/main/task-companion';
import { TaskListService } from '../../src/main/task-list';
import type { LinkedTask } from '../../src/shared/contracts';
import { bubbleBounds, bubbleDocument } from '../../src/main/pet-surfaces';

const id = '00000000-0000-4000-8000-000000000001';
const account1 = '00000000-0000-4000-8000-000000000010';
const account2 = '00000000-0000-4000-8000-000000000020';
const task = (): LinkedTask => ({ id, name: '提交报告', priority: 'high', completed: false, createdAt: '2026-10-22T01:00:00Z', reminderAt: null, elapsedSeconds: 90 });
function fixture() {
  let now = Date.parse('2026-10-22T01:00:00Z'); let monotonic = 0; let account: string | undefined = account1; let revision = 1;
  let persisted: unknown = null; let fail = false; let lost = false; let diskFail = false;
  let blocker: (() => Promise<void>) | undefined;
  const items = [task()]; const notifications: { title: string; body: string }[] = []; const writes: number[] = []; let reads = 0;
  const check = (expected: number) => { if (!account || expected !== revision) throw new Error('账号已切换'); };
  const service = {
    accountKey: () => account, accountRevision: () => revision,
    list: async (_view: string, expected: number) => { check(expected); reads++; return { view: 'today', date: '2026-10-22', items: structuredClone(items), fetchedAt: new Date(now).toISOString() }; },
    getDaily: async (_id: string, expected: number) => { check(expected); return { ...items[0]! }; },
    saveElapsed: async (_id: string, total: number, expected: number) => {
      check(expected); writes.push(total); if (fail) throw new Error('网络断开');
      if (blocker) await blocker();
      check(expected); items[0]!.elapsedSeconds = Math.max(items[0]!.elapsedSeconds!, total);
      if (lost) { lost = false; throw new Error('保存成功后响应丢失'); }
      return { ...items[0]! };
    },
  } as unknown as TaskListService;
  const options = {
    now: () => new Date(now), monotonic: () => monotonic,
    load: async () => structuredClone(persisted), save: async (data: unknown) => { if (diskFail) throw new Error('磁盘不可写'); persisted = structuredClone(data); },
    notify: (title: string, body: string) => notifications.push({ title, body }),
  };
  const companion = new TaskCompanion(service, options);
  return { companion, service, items, notifications, writes, reads: () => reads,
    advance(ms: number) { now += ms; monotonic += ms; }, wall(ms: number) { now += ms; },
    time(iso: string) { now = Date.parse(iso); }, switch(key?: string) { account = key; revision++; }, revision: () => revision,
    fail(value: boolean) { fail = value; }, lose() { lost = true; }, disk(value: boolean) { diskFail = value; },
    block(fn?: () => Promise<void>) { blocker = fn; }, restored: () => new TaskCompanion(service, options), saved: () => persisted,
  };
}

test('preferences validate exact fields and overnight quiet hours use Shanghai time', () => {
  assert.deepEqual(companionPreferences(companionDefaults), companionDefaults);
  assert.throws(() => companionPreferences({ ...companionDefaults, morningTime: '25:00' }));
  assert.throws(() => companionPreferences({ ...companionDefaults, morning: 'true' }));
  assert.throws(() => companionPreferences({ ...companionDefaults, token: 'not-allowed' }));
  assert.equal(isQuiet(companionDefaults, new Date('2026-10-22T15:00:00Z')), true);
  assert.equal(isQuiet(companionDefaults, new Date('2026-10-22T00:00:00Z')), false);
  assert.equal(isQuiet({ ...companionDefaults, quietStart: '12:00', quietEnd: '14:00' }, new Date('2026-10-22T05:00:00Z')), true);
  assert.equal(isQuiet({ ...companionDefaults, quietStart: '12:00', quietEnd: '12:00' }, new Date('2026-10-22T05:00:00Z')), false);
});

test('disabled defaults perform no task reads or notifications', async () => {
  const f = fixture(); await f.companion.tick(); assert.equal(f.reads(), 0); assert.equal(f.notifications.length, 0);
});

test('overdue reminders deduplicate across polling and restart but changed occurrence reminds again', async () => {
  const f = fixture(); f.items[0]!.reminderAt = '2026-10-22T00:00:00Z';
  await f.companion.configure({ ...companionDefaults, reminders: true });
  await f.companion.tick(); f.advance(31000); await f.companion.tick(); assert.equal(f.notifications.length, 1);
  const restored = f.restored(); await restored.restore(); await restored.tick(); assert.equal(f.notifications.length, 1);
  f.items[0]!.reminderAt = '2026-10-22T00:05:00Z'; f.advance(31000); await restored.tick(); assert.equal(f.notifications.length, 2);
});

test('quiet hours defer rather than dismiss overdue reminder; completed/no-reminder tasks never notify', async () => {
  const f = fixture(); f.time('2026-10-22T23:50:00Z'); f.items[0]!.reminderAt = '2026-10-22T23:00:00Z';
  await f.companion.configure({ ...companionDefaults, reminders: true }); await f.companion.tick(); assert.equal(f.notifications.length, 0);
  f.advance(11 * 60_000); await f.companion.tick(); assert.equal(f.notifications.length, 1);
  f.items[0]!.completed = true; f.items[0]!.reminderAt = '2026-10-22T23:05:00Z'; f.advance(31000); await f.companion.tick();
  assert.equal(f.notifications.length, 1);
});

test('morning and evening reports are once per Shanghai day and persisted; manual report is always available', async () => {
  const f = fixture();
  await f.companion.configure({ ...companionDefaults, morning: true, evening: true });
  await f.companion.tick(); assert.equal(f.notifications.length, 1);
  f.advance(31000); await f.companion.tick(); assert.equal(f.notifications.length, 1);
  const second = f.restored(); await second.restore(); await second.tick(); assert.equal(f.notifications.length, 1);
  f.time('2026-10-22T13:00:00Z'); await second.tick(); assert.equal(f.notifications.length, 2);
  assert.match(await second.briefing('evening'), /重点.*提交报告/);
  assert.match(await second.briefing('evening'), /原任务/);
});

test('late login skips stale morning report instead of announcing morning and evening together', async () => {
  const f = fixture(); f.time('2026-10-22T13:00:00Z');
  await f.companion.configure({ ...companionDefaults, morning: true, evening: true }); await f.companion.tick();
  assert.deepEqual(f.notifications.map((n) => n.title), ['晚间复盘']);
});

test('focus uses monotonic active time, pause/resume and stop save absolute increasing seconds', async () => {
  const f = fixture();
  await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000); f.wall(3600000);
  assert.equal(f.companion.status().focus.seconds, 100, 'wall clock jumps do not inflate work');
  await f.companion.focus({ action: 'pause' }); assert.equal(f.items[0]!.elapsedSeconds, 100);
  f.advance(600000); assert.equal(f.companion.status().focus.seconds, 100);
  await f.companion.focus({ action: 'resume' }); f.advance(10000); await f.companion.focus({ action: 'stop' });
  assert.equal(f.companion.status().focus.phase, 'idle'); assert.equal(f.items[0]!.elapsedSeconds, 110);
  assert.deepEqual(f.writes, [100, 110]);
});

test('failed and lost-response focus writes preserve exact totals and retry cannot double-add', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(11000); f.fail(true);
  await assert.rejects(f.companion.focus({ action: 'stop' }), /尚未同步/);
  assert.equal(f.companion.status().focus.phase, 'paused'); assert.equal(f.companion.status().focus.seconds, 101);
  f.fail(false); f.lose(); await assert.rejects(f.companion.focus({ action: 'retry' }));
  assert.equal(f.items[0]!.elapsedSeconds, 101);
  await f.companion.focus({ action: 'retry' }); await f.companion.focus({ action: 'stop' });
  assert.deepEqual(f.writes, [101, 101, 101]); assert.equal(f.items[0]!.elapsedSeconds, 101);
});

test('focus checkpoints restore paused and preserve unsynced time after restart', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(11000); f.fail(true); await f.companion.tick();
  const restored = f.restored(); await restored.restore(); assert.equal(restored.status().focus.phase, 'paused'); assert.equal(restored.status().focus.seconds, 101);
  f.fail(false); await restored.focus({ action: 'retry' }); assert.equal(f.items[0]!.elapsedSeconds, 101);
});

test('timer caps at round duration, announces once and cannot resume an expired round', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 1 }); f.advance(5 * 60000); await f.companion.tick();
  assert.equal(f.companion.status().focus.seconds, 150); assert.equal(f.companion.status().focus.remaining, 0);
  assert.equal(f.companion.status().focus.phase, 'paused'); assert.equal(f.notifications.length, 1);
  f.advance(31000); await f.companion.tick(); assert.equal(f.notifications.length, 1);
  await assert.rejects(f.companion.focus({ action: 'resume' }), /本轮已结束/);
});

test('suspend pauses immediately even while a remote checkpoint is blocked', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000);
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.block(() => new Promise<void>((resolve) => { release = resolve; started(); }));
  const tick = f.companion.tick(); await entered;
  const suspended = f.companion.suspend(); f.advance(3600000); assert.equal(f.companion.status().focus.seconds, 100);
  release(); await tick; await suspended; assert.equal(f.companion.status().focus.phase, 'paused');
});

test('status polling during remote flush never drops elapsed work', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000);
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.block(() => new Promise<void>((resolve) => { release = resolve; started(); }));
  const tick = f.companion.tick(); await entered; f.advance(5000); assert.equal(f.companion.status().focus.seconds, 105);
  release(); await tick; assert.equal(f.companion.status().focus.seconds, 105);
});

test('remote higher time never decreases, and local work after checkpoint adds on top', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000); f.items[0]!.elapsedSeconds = 300;
  await f.companion.tick(); assert.equal(f.companion.status().focus.seconds, 300);
  f.advance(5000); await f.companion.focus({ action: 'stop' }); assert.equal(f.items[0]!.elapsedSeconds, 305);
});

test('account switch isolates preferences and timers; stale completion cannot celebrate for new account', async () => {
  const f = fixture(); await f.companion.configure({ ...companionDefaults, reminders: true });
  await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000); await f.companion.suspend();
  const old = f.revision(); f.switch(account2); assert.equal(f.companion.status().preferences.reminders, false); assert.equal(f.companion.status().focus.phase, 'idle');
  await f.companion.completed(task(), old); assert.equal(f.notifications.length, 0);
  f.switch(account1); assert.equal(f.companion.status().focus.phase, 'paused'); assert.equal(f.companion.status().focus.seconds, 100);
  assert.equal(f.companion.status().preferences.reminders, true);
});

test('completed task ends matching focus after sync and saved task feedback respects quiet hours', async () => {
  const f = fixture(); await f.companion.focus({ action: 'start', id, minutes: 25 }); f.advance(10000);
  await f.companion.completed(task(), f.revision()); assert.equal(f.companion.status().focus.phase, 'idle'); assert.equal(f.notifications.length, 1);
  f.time('2026-10-22T15:00:00Z'); await f.companion.completed(task(), f.revision()); assert.equal(f.notifications.length, 1);
});

test('invalid focus input, completed tasks and overlapping rounds are rejected', async () => {
  const f = fixture(); await assert.rejects(f.companion.focus({ action: 'start', id, minutes: 999 }));
  f.items[0]!.completed = true; await assert.rejects(f.companion.focus({ action: 'start', id, minutes: 25 }), /已完成/);
  f.items[0]!.completed = false; await f.companion.focus({ action: 'start', id, minutes: 25 });
  await assert.rejects(f.companion.focus({ action: 'start', id, minutes: 25 }), /先结束/);
  await assert.rejects(f.companion.focus({ action: 'destroy' }));
});

test('failed preferences persistence rolls back and reports failure', async () => {
  const f = fixture(); f.disk(true); await assert.rejects(f.companion.configure({ ...companionDefaults, reminders: true }));
  assert.equal(f.companion.status().preferences.reminders, false);
});

test('weekly breakdown is only a preview with unique retry ids, explicit no-AI fallback and valid calendar dates', async () => {
  const result = await draftWeeklyPlan({ goal: '完成产品上线', date: '2026-10-30' });
  assert.equal(result.ai, false); assert.equal(result.items.length, 5); assert.equal(new Set(result.items.map((item) => item.id)).size, 5);
  assert.deepEqual(result.items.map((item) => item.date), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  await assert.rejects(draftWeeklyPlan({ goal: '任务', date: '2026-02-30' }));
  await assert.rejects(draftWeeklyPlan({ goal: ' ', date: '2026-10-22' }));
});

test('bubble uses independent fixed dimensions and stays above pet at all scales and negative monitor coordinates', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  for (const size of [110, 132, 176, 220, 264, 330]) {
    const pet = { x: -1000, y: 500, width: size, height: size }; const bubble = bubbleBounds(pet, area);
    assert.equal(bubble.width, 280); assert.ok(bubble.y + bubble.height < pet.y); assert.ok(bubble.x >= area.x);
    assert.equal(pet.y - bubble.y - bubble.height, 2, 'bubble stays close with a fixed gap');
  }
  const atTop = bubbleBounds({ x: -1000, y: 0, width: 176, height: 176 }, area);
  assert.ok(atTop.x >= -1000 + 176 || atTop.x + atTop.width <= -1000); assert.equal(atTop.y, 0);
  const document = bubbleDocument('<script>steal()</script>' + '你'.repeat(200));
  assert.ok(document.includes('font-size:14px')); assert.ok(!document.includes('<script>')); assert.match(document, /&lt;script&gt;/);
  assert.ok(document.includes('rgba(255,253,249,.8)'), 'translucent panel keeps opaque readable text');
});
