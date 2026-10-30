import type { LinkedTask, TaskFocusStatus, TaskListSnapshot, TaskListStatus, TaskListView } from '../shared/contracts';
import { randomUUID } from 'node:crypto';
import { carryTaskId, sortLinkedTasks } from './task-rules';

export const TASK_LIST_WEBSITE = 'https://dong2003610.github.io/daily-task-list/';
const PAGE_SIZE = 500;
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const PRIORITY = { high: 0, medium: 1, low: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = 'id,name,priority,completed,created_at,updated_at';
const DAILY_FIELDS = `${FIELDS},reminder_at,elapsed_seconds,sort_order,completed_at`;

interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  username: string;
  remember: boolean;
}

interface Options {
  url: string;
  publicKey: string;
  load: () => Promise<unknown>;
  save: (session: unknown | null) => Promise<void>;
  canRemember: () => boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

class RequestError extends Error {
  constructor(readonly status: number) { super('任务服务请求失败'); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function validTaskDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(date.getTime()) && taskListDate(date) === value;
}

function linkedTask(value: unknown): LinkedTask {
  const task = record(value);
  if (typeof task.id !== 'string' || !UUID.test(task.id) || typeof task.name !== 'string' || task.name.length > 500
    || typeof task.completed !== 'boolean' || !['high', 'medium', 'low'].includes(String(task.priority))
    || typeof task.created_at !== 'string' || !Number.isFinite(Date.parse(task.created_at))) throw new Error('任务数据格式异常，请稍后重试。');
  return { id: task.id, name: task.name, priority: task.priority as LinkedTask['priority'], completed: task.completed,
    createdAt: task.created_at, reminderAt: typeof task.reminder_at === 'string' && Number.isFinite(Date.parse(task.reminder_at)) ? task.reminder_at : null,
    elapsedSeconds: typeof task.elapsed_seconds === 'number' && Number.isFinite(task.elapsed_seconds) && task.elapsed_seconds >= 0 ? Math.floor(task.elapsed_seconds) : 0,
    sortOrder: typeof task.sort_order === 'number' && Number.isFinite(task.sort_order) ? task.sort_order : null,
    completedAt: typeof task.completed_at === 'string' ? task.completed_at : null,
    ...(typeof task.updated_at === 'string' ? { updatedAt: task.updated_at } : {}) };
}

function parseSession(value: unknown): Session | undefined {
  const data = record(value);
  if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.refreshToken !== 'string' || !data.refreshToken
    || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)
    || typeof data.userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.userId)
    || typeof data.username !== 'string' || !data.username || data.username.length > 100 || data.remember !== true) return;
  return data as unknown as Session;
}

export function taskListDate(now: Date): string {
  return new Date(now.getTime() + EIGHT_HOURS).toISOString().slice(0, 10);
}

export function taskListWeek(now: Date): string {
  const shifted = new Date(now.getTime() + EIGHT_HOURS);
  shifted.setUTCDate(shifted.getUTCDate() - (shifted.getUTCDay() + 6) % 7);
  return shifted.toISOString().slice(0, 10);
}

// All session operations and reads are serialized: an old refresh cannot restore
// a logged-out account or overwrite a newer login's credentials.
export class TaskListService {
  private readonly focusClient = `desktop:${randomUUID()}`;
  private session?: Session;
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly request: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: Options) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async restore(): Promise<void> {
    return this.serial(async () => {
      try { this.session = parseSession(await this.options.load()); this.revision += 1; }
      catch { this.session = undefined; }
    });
  }

  status(): TaskListStatus {
    return { connected: Boolean(this.session), username: this.session?.username, remembered: this.session?.remember ?? false, canRemember: this.options.canRemember() };
  }

  accountRevision(): number { return this.revision; }
  accountKey(): string | undefined { return this.session?.userId; }

  private assertAccount(expected?: number): void {
    if (expected !== undefined && expected !== this.revision) throw new Error('清单账号已切换，请重新操作。');
  }

  private async json(route: string, init: RequestInit = {}, token?: string): Promise<unknown> {
    try {
      const response = await this.request(`${this.options.url}${route}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), apikey: this.options.publicKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) throw new RequestError(response.status);
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new Error('无法连接任务清单，请检查网络后重试。');
    }
  }

  private sessionFromResponse(value: unknown, username: string, remember: boolean): Session {
    const data = record(value);
    const user = record(data.user);
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token
      || typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)
      || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('登录信息不完整，请重新连接账号。');
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token, userId: user.id,
      expiresAt: this.now().getTime() + data.expires_in * 1000, username, remember };
  }

  login(input: unknown): Promise<TaskListStatus> {
    return this.serial(async () => {
      const data = record(input);
      if (typeof data.username !== 'string' || !data.username.trim() || data.username.trim().length > 100
        || typeof data.password !== 'string' || !data.password || data.password.length > 1000 || typeof data.remember !== 'boolean') {
        throw new Error('请输入原清单账号的用户名和密码。');
      }
      if (data.remember && !this.options.canRemember()) throw new Error('本机加密存储不可用，请取消“记住登录”后重试。');
      const username = data.username.trim();
      let response: unknown;
      try {
        response = await this.json('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: `${username}@miaoda.com`, password: data.password }) });
      } catch (error) {
        if (error instanceof RequestError) throw new Error(error.status === 429 ? '登录过于频繁，请稍后重试。' : '登录失败，请检查用户名和密码后重试。');
        throw error;
      }
      const session = this.sessionFromResponse(response, username, data.remember);
      try { await this.options.save(session.remember ? session : null); }
      catch { throw new Error('无法保存登录信息，请取消“记住登录”后重试。'); }
      this.session = session;
      this.revision += 1;
      return this.status();
    });
  }

  logout(): Promise<TaskListStatus> {
    return this.serial(async () => {
      // Remove persisted credentials first so a failed disk write cannot report
      // a successful logout while restoring that account on the next launch.
      await this.options.save(null);
      this.session = undefined;
      this.revision += 1;
      return this.status();
    });
  }

  private async refresh(): Promise<Session> {
    const previous = this.session;
    if (!previous) throw new Error('请先在“清单”页连接你的账号。');
    let result: unknown;
    try {
      result = await this.json('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: previous.refreshToken }) });
    } catch (error) {
      if (error instanceof RequestError && [400, 401, 403].includes(error.status)) {
        await this.options.save(null);
        this.session = undefined;
        this.revision += 1;
        throw new Error('清单登录已失效，请在“清单”页重新登录。');
      }
      throw new Error('清单会话暂时无法续期，请检查网络后重试。');
    }
    const session = this.sessionFromResponse(result, previous.username, previous.remember);
    if (session.userId !== previous.userId) throw new Error('账号验证失败，请断开后重新登录。');
    // Keep the rotated token in memory even if the disk is temporarily full.
    this.session = session;
    if (session.remember) {
      try { await this.options.save(session); }
      catch { throw new Error('登录续期成功，但本机保存失败，请重试或重新登录。'); }
    }
    return session;
  }

  private async authorized(route: string, init: RequestInit, expected?: number): Promise<unknown> {
    this.assertAccount(expected);
    let session = this.session;
    if (!session) throw new Error('请先在“清单”页连接你的账号。');
    if (session.expiresAt <= this.now().getTime() + 60_000) session = await this.refresh();
    try { return await this.json(route, init, session.accessToken); }
    catch (error) {
      if (!(error instanceof RequestError) || error.status !== 401) throw error;
      session = await this.refresh();
      return this.json(route, init, session.accessToken);
    }
  }

  create(input: unknown, expected?: number): Promise<LinkedTask> {
    return this.serial(async () => {
      this.assertAccount(expected);
      const data = record(input);
      if (Object.keys(data).some((key) => !['id', 'kind', 'name', 'priority', 'date', 'reminderAt'].includes(key))
        || typeof data.id !== 'string' || !UUID.test(data.id) || !['daily', 'weekly'].includes(String(data.kind))
        || typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 500
        || !['high', 'medium', 'low'].includes(String(data.priority)) || !validTaskDate(data.date)
        || (data.reminderAt !== undefined && data.reminderAt !== null && (data.kind !== 'daily' || typeof data.reminderAt !== 'string' || !Number.isFinite(Date.parse(data.reminderAt))))) throw new Error('任务名称、日期或优先级不正确。');
      const session = this.session;
      if (!session) throw new Error('请先在“清单”页连接你的账号。');
      const weekly = data.kind === 'weekly';
      const table = weekly ? 'weekly_tasks' : 'tasks';
      const name = data.name.trim();
      const createdAt = data.date === taskListDate(this.now()) || weekly ? this.now().toISOString() : new Date(`${data.date}T00:00:00+08:00`).toISOString();
      const row = { id: data.id.toLowerCase(), user_id: session.userId, name, priority: data.priority, completed: false, completed_at: null, created_at: createdAt,
        ...(weekly ? { week_start: taskListWeek(new Date(`${data.date}T12:00:00+08:00`)) } : { reminder_at: data.reminderAt ?? null, reminder_method: data.reminderAt ? 'dialog' : null, elapsed_seconds: 0 }) };
      try {
        const params = new URLSearchParams({ on_conflict: 'id', select: weekly ? FIELDS : DAILY_FIELDS });
        const result = await this.authorized(`/rest/v1/${table}?${params}`, { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(row) }, expected);
        if (!Array.isArray(result)) throw new Error('任务保存结果异常，请使用同一次操作重试。');
        if (result.length === 1) return linkedTask(result[0]);
        if (result.length) throw new Error('任务保存结果异常，请刷新核对。');
        // Retrying the same UUID after a lost response must not create a second task.
        const query = new URLSearchParams({ id: `eq.${row.id}`, user_id: `eq.${session.userId}`, select: weekly ? `${FIELDS},week_start` : DAILY_FIELDS });
        const existing = await this.authorized(`/rest/v1/${table}?${query}`, {}, expected);
        if (!Array.isArray(existing) || existing.length !== 1) throw new Error('无法核对任务保存结果，请重试。');
        const saved = linkedTask(existing[0]);
        if (saved.name !== name || saved.priority !== data.priority || (!weekly && saved.reminderAt !== (data.reminderAt ?? null))
          || (weekly ? record(existing[0]).week_start !== (row as { week_start?: string }).week_start : taskListDate(new Date(saved.createdAt)) !== data.date)) throw new Error('这次操作的任务已被修改，请刷新核对。');
        return saved;
      } catch (error) {
        if (error instanceof RequestError) throw new Error(weekly && error.status === 404 ? '周计划尚未启用，请先完成数据库升级。' : '任务保存失败，请重试；同一次重试不会重复创建。');
        throw error;
      }
    });
  }

  update(input: unknown, expected?: number): Promise<LinkedTask> {
    return this.serial(async () => {
      this.assertAccount(expected);
      const data = record(input);
      const patch = record(data.patch);
      if (Object.keys(data).some((key) => !['id', 'kind', 'patch', 'expectedUpdatedAt'].includes(key))
        || typeof data.id !== 'string' || !UUID.test(data.id) || !['daily', 'weekly'].includes(String(data.kind))
        || !Object.keys(patch).length || Object.keys(patch).some((key) => !['name', 'priority', 'completed', 'reminderAt', 'date'].includes(key))
        || ('date' in patch && (data.kind !== 'daily' || !validTaskDate(patch.date)))
        || ('name' in patch && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > 500))
        || ('priority' in patch && !['high', 'medium', 'low'].includes(String(patch.priority)))
        || ('completed' in patch && typeof patch.completed !== 'boolean')
        || ('reminderAt' in patch && (data.kind !== 'daily' || (patch.reminderAt !== null && (typeof patch.reminderAt !== 'string' || !Number.isFinite(Date.parse(patch.reminderAt))))))
        || (data.expectedUpdatedAt !== undefined && (typeof data.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(data.expectedUpdatedAt))))) throw new Error('任务修改内容不正确。');
      const session = this.session;
      if (!session) throw new Error('请先在“清单”页连接你的账号。');
      const query = new URLSearchParams({ id: `eq.${data.id}`, user_id: `eq.${session.userId}`, select: data.kind === 'weekly' ? FIELDS : DAILY_FIELDS });
      if (typeof data.expectedUpdatedAt === 'string') query.set('updated_at', `eq.${data.expectedUpdatedAt}`);
      const { reminderAt: _reminder, date: _date, ...safePatch } = patch;
      const changes = { ...safePatch, ...('name' in patch ? { name: (patch.name as string).trim() } : {}),
        ...('date' in patch ? { created_at: new Date(`${patch.date}T00:00:00+08:00`).toISOString(), sort_order: null } : {}),
        ...('reminderAt' in patch ? { reminder_at: patch.reminderAt, reminder_method: patch.reminderAt ? 'dialog' : null } : {}),
        ...('completed' in patch ? { completed_at: patch.completed ? this.now().toISOString() : null } : {}) };
      try {
        const result = await this.authorized(`/rest/v1/${data.kind === 'weekly' ? 'weekly_tasks' : 'tasks'}?${query}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(changes) }, expected);
        if (!Array.isArray(result) || result.length !== 1) throw new Error('任务已发生变化或不存在，请刷新后重试。');
        return linkedTask(result[0]);
      } catch (error) {
        if (error instanceof RequestError) throw new Error('任务修改失败，请刷新核对后重试。');
        throw error;
      }
    });
  }

  getDaily(id: string, expected?: number): Promise<LinkedTask> {
    return this.serial(async () => {
      this.assertAccount(expected);
      if (!UUID.test(id) || !this.session) throw new Error('任务或账号无效。');
      const params = new URLSearchParams({ id: `eq.${id}`, user_id: `eq.${this.session.userId}`, select: DAILY_FIELDS });
      const result = await this.authorized(`/rest/v1/tasks?${params}`, {}, expected);
      if (!Array.isArray(result) || result.length !== 1) throw new Error('任务已不存在，请刷新。');
      return linkedTask(result[0]);
    });
  }

  saveElapsed(id: string, seconds: number, expected: number): Promise<LinkedTask> {
    return this.serial(async () => {
      this.assertAccount(expected);
      if (!UUID.test(id) || !Number.isSafeInteger(seconds) || seconds < 0 || !this.session) throw new Error('专注计时数据无效。');
      const params = new URLSearchParams({ id: `eq.${id}`, user_id: `eq.${this.session.userId}`, elapsed_seconds: `lte.${seconds}`, select: DAILY_FIELDS });
      const result = await this.authorized(`/rest/v1/tasks?${params}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ elapsed_seconds: seconds }) }, expected);
      if (!Array.isArray(result)) throw new Error('保存专注时长失败，请重试。');
      if (result.length === 1) return linkedTask(result[0]);
      params.delete('elapsed_seconds');
      const current = await this.authorized(`/rest/v1/tasks?${params}`, {}, expected);
      if (!Array.isArray(current) || current.length !== 1) throw new Error('任务已不存在，请先保留本地计时。');
      return linkedTask(current[0]);
    });
  }

  list(view: unknown, expected?: number, day?: string, includeCompleted = false): Promise<TaskListSnapshot> {
    return this.serial(async () => {
      this.assertAccount(expected);
      if (view !== 'today' && view !== 'pending' && view !== 'week') throw new Error('不支持的清单视图。');
      if (day !== undefined && !validTaskDate(day)) throw new Error('任务日期不正确。');
      let session = this.session;
      if (!session) throw new Error('请先在“清单”页连接你的账号。');
      if (session.expiresAt <= this.now().getTime() + 60_000) session = await this.refresh();
      const now = this.now();
      const date = day ?? (view === 'week' ? taskListWeek(now) : taskListDate(now));
      const items: LinkedTask[] = [];
      let cursor = '';
      for (let page = 0; ; page += 1) {
        if (page >= 100) throw new Error('任务数量较多，请打开网页版查看完整清单。');
        const query = new URLSearchParams({
          select: view === 'week' ? FIELDS : DAILY_FIELDS,
          user_id: `eq.${session.userId}`, order: 'id.asc', limit: String(PAGE_SIZE),
        });
        if (view === 'week') query.set('week_start', `eq.${date}`);
        if (view === 'pending' && !includeCompleted) query.set('completed', 'eq.false');
        if (view === 'today') {
          const start = new Date(`${date}T00:00:00+08:00`);
          query.set('created_at', `gte.${start.toISOString()}`);
          query.set('and', `(created_at.lt.${new Date(start.getTime() + 86400_000).toISOString()})`);
        }
        if (cursor) query.set('id', `gt.${cursor}`);
        const route = `/rest/v1/${view === 'week' ? 'weekly_tasks' : 'tasks'}?${query}`;
        let rows: unknown;
        try {
          try { rows = await this.json(route, {}, session.accessToken); }
          catch (error) {
            if (!(error instanceof RequestError) || error.status !== 401) throw error;
            session = await this.refresh();
            rows = await this.json(route, {}, session.accessToken);
          }
        } catch (error) {
          if (error instanceof RequestError) {
            if (view === 'week' && error.status === 404) throw new Error('周计划尚未启用，请先在清单项目完成数据库升级。');
            if (error.status === 401 || error.status === 403) throw new Error('清单授权失效，请断开后重新登录。');
            throw new Error('读取任务失败，请稍后重试。');
          }
          throw error;
        }
        if (!Array.isArray(rows)) throw new Error('任务数据格式异常，请稍后重试。');
        for (const row of rows) {
          const task = linkedTask(row);
          if (cursor && task.id <= cursor) throw new Error('清单分页异常，请刷新重试。');
          items.push(task);
        }
        if (rows.length < PAGE_SIZE) break;
        const next = record(rows[rows.length - 1]).id as string;
        if (next === cursor) throw new Error('清单分页异常，请刷新重试。');
        cursor = next;
      }
      return { view, date, fetchedAt: this.now().toISOString(), items: sortLinkedTasks(items) };
    });
  }

  async rollover(date: string, expected = this.revision): Promise<import('../shared/contracts').TaskListCreateInput[]> {
    if (!validTaskDate(date)) throw new Error('接续日期不正确。');
    const pending = await this.list('pending', expected, undefined, true);
    const target = await this.list('today', expected, date);
    const metadata = await this.serial(() => this.workspace(expected));
    const ids = new Set([...pending.items, ...target.items].map((item) => item.id));
    const dates = [...new Set(pending.items.map((item) => taskListDate(new Date(item.createdAt))))];
    const sources = pending.items.filter((item) => !item.completed && !metadata[`dtl_carry_cancel_v2_${item.id}`] && taskListDate(new Date(item.createdAt)) < date
      && !ids.has(carryTaskId(item.id, date))
      && !dates.some((day) => day > taskListDate(new Date(item.createdAt)) && ids.has(carryTaskId(item.id, day))));
    if (sources.length > 50) throw new Error('未完成任务超过 50 项，请先打开完整清单整理。');
    return sources.map((item) => ({ id: carryTaskId(item.id, date), kind: 'daily', name: item.name, date, priority: item.priority,
      reminderAt: item.reminderAt && Date.parse(item.reminderAt) > this.now().getTime() ? item.reminderAt : null }));
  }

  private async workspace(expected: number): Promise<Record<string, unknown>> {
    const user = record(await this.authorized('/auth/v1/user', {}, expected));
    if (user.id !== this.session?.userId) throw new Error('清单账号验证失败，请重新登录。');
    return record(user.user_metadata);
  }
  reminderOwner(enabled?: boolean, expected = this.revision): Promise<'desktop' | 'web'> {
    return this.serial(async () => {
      if (enabled !== undefined) await this.authorized('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dtl_reminder_owner_v1: enabled ? 'desktop' : 'web' } }) }, expected);
      const meta = await this.workspace(expected);
      return meta.dtl_reminder_owner_v1 === 'desktop' ? 'desktop' : 'web';
    });
  }
  claimFocus(focus: TaskFocusStatus, expected = this.revision): Promise<void> {
    return this.serial(async () => {
      const meta = await this.workspace(expected); const current = record(meta.dtl_focus_v1);
      if (current.client !== this.focusClient && current.phase === 'running' && typeof current.expiresAt === 'number' && current.expiresAt > this.now().getTime()) throw new Error(`已有${current.owner === 'web' ? '网页' : '另一台桌宠'}正在专注，请先在那里暂停或结束。`);
      const lease = { client: this.focusClient, owner: 'desktop', phase: focus.phase, taskId: focus.taskId, name: focus.name, seconds: focus.seconds, remaining: focus.remaining, expiresAt: this.now().getTime() + 90000 };
      await this.authorized('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dtl_focus_v1: lease } }) }, expected);
      const verified = record((await this.workspace(expected)).dtl_focus_v1);
      if (verified.client !== this.focusClient) throw new Error('另一端刚刚开始了专注，请刷新后重试。');
    });
  }
  releaseFocus(expected = this.revision): Promise<void> {
    return this.serial(async () => {
      const meta = await this.workspace(expected);
      if (record(meta.dtl_focus_v1).client === this.focusClient) await this.authorized('/auth/v1/user', { method: 'PUT', body: JSON.stringify({ data: { dtl_focus_v1: null } }) }, expected);
    });
  }
}

// Task query contents are kept out of the AI prompt; local receipts remain available.
// Queries work without an AI key, and cannot execute a database write.
export function parseTaskListQuery(text: string): TaskListView | 'unsupported' | undefined {
  const input = text.trim();
  const mentionsList = /任务|待办|清单|周计划|周目标|daily[-\s]?task[-\s]?list/i.test(input);
  if (!mentionsList && !/^(?:我)?(?:今天|今日|本周|这周)(?:还有|有|要做|需要做).*(?:没做|未完成|做什么|做啥|做哪些|什么没做)/.test(input)) return;
  if (/新增|添加|创建|记下|记一下|标记|勾选|删除|移除|改成|修改|更新|取消|安排/.test(input)) return 'unsupported';
  if (/本周|这周|周计划|周目标/.test(input)) return 'week';
  if (mentionsList && /全部|所有|历史|遗留|之前/.test(input)) return 'pending';
  if (/今天|今日/.test(input)) return 'today';
  if (/有哪些|有什么|列出|查看|看看|查一下|查询|没做|未完成|待完成|还剩|进度|统计|多少|几个|几项/.test(input)) return 'pending';
  return;
}

export function formatTaskListReply(snapshot: TaskListSnapshot, today = taskListDate(new Date())): string {
  const pending = snapshot.items.filter((item) => !item.completed);
  const title = snapshot.view === 'week' ? `${snapshot.date} 起的周计划` : snapshot.view === 'today' ? (snapshot.date === today ? '今日任务' : `${snapshot.date} 的任务`) : '全部未完成任务';
  if (!snapshot.items.length) return `${title}暂无记录，可以直接告诉我要添加什么，或在“今天”里手动添加。`;
  const summary = snapshot.view === 'pending' ? `${title}：${pending.length} 项。` : `${title}：共 ${snapshot.items.length} 项，已完成 ${snapshot.items.length - pending.length} 项，未完成 ${pending.length} 项。`;
  if (!pending.length) return `${summary}\n全部完成啦，辛苦了！`;
  const names = pending.slice(0, 5).map((task, index) => `${index + 1}. ${task.priority === 'high' ? '【高优先级】' : ''}${task.name.length > 60 ? `${task.name.slice(0, 60)}…` : task.name}`);
  return [summary, ...names, ...(pending.length > 5 ? [`还有 ${pending.length - 5} 项，可在“今天”查看。`] : [])].join('\n');
}
