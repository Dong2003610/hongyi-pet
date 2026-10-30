import { randomUUID } from 'node:crypto';
import type { ChatCard, ChatMessage, LinkedTask, TaskListCreateInput, TaskListKind, TaskListSnapshot, TaskListUpdateInput } from '../shared/contracts';
import { chatWithAi, type AiConfig } from './ai-chat';
import { formatTaskListReply, parseTaskListQuery, TaskListService, taskListDate, taskListWeek, validTaskDate } from './task-list';
import { actionable, actionQuestion, companionCandidate, localCompanionIntent, requestText, taskReminderTime, validateCompanionIntent, type CompanionIntent } from './task-chat-intents';
import { briefingText, type TaskCompanion } from './task-companion';
import { cleanTaskTarget, normalizeTaskName, quotedTaskTarget, rankTaskTargets, taskInstructionText, taskOrdinal } from './task-targets';

type Create = Omit<TaskListCreateInput, 'id'> & { type: 'create' };
type Update = { type: 'update'; target: string; kind: TaskListKind; date?: string; patch: TaskListUpdateInput['patch'] };
type Command = Create | Update;
type FocusCommand = { type: 'focus'; action: 'start'; kind: 'daily'; target: string; minutes: number; date?: string };
type TargetCommand = Update | FocusCommand;
const normalize = normalizeTaskName;
const kindOf = (text: string): TaskListKind => /周计划|周目标|(?:本周|这周|下周).*(?:任务|计划)/.test(text) ? 'weekly' : 'daily';

export function resolveTaskDate(text: string, now: Date): string | undefined {
  const explicit = /\d{4}-\d{1,2}-\d{1,2}/.exec(text)?.[0];
  if (explicit) {
    const [year, month, day] = explicit.split('-');
    const date = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
    return validTaskDate(date) ? date : undefined;
  }
  const today = taskListDate(now);
  const day = new Date(`${today}T12:00:00+08:00`);
  const shift = (n: number) => taskListDate(new Date(day.getTime() + n * 86400_000));
  if (/大后天/.test(text)) return shift(3);
  if (/后天/.test(text)) return shift(2);
  if (/明天/.test(text)) return shift(1);
  if (/昨天/.test(text)) return shift(-1);
  if (/今天|今日/.test(text)) return today;
  const week = /(?:(下|本|这)周|周)([一二三四五六日天])/.exec(text);
  if (week) {
    const weekday = '一二三四五六日'.indexOf(week[2]!.replace('天', '日'));
    const monday = new Date(`${taskListWeek(now)}T12:00:00+08:00`);
    let result = new Date(monday.getTime() + (weekday + (week[1] === '下' ? 7 : 0)) * 86400_000);
    if (!week[1] && taskListDate(result) < today) result = new Date(result.getTime() + 7 * 86400_000);
    return taskListDate(result);
  }
  if (/下周/.test(text)) return taskListDate(new Date(new Date(`${taskListWeek(now)}T12:00:00+08:00`).getTime() + 7 * 86400_000));
  return undefined;
}

function cleanTarget(text: string): string {
  if (/^(?:这个|这项|这条|那个|那项|刚才那个|刚才的|它)(?:任务|待办)?$/.test(text.trim())) return text.trim().replace(/(?:任务|待办)$/, '');
  return cleanTaskTarget(text);
}

function isInstruction(text: string): boolean {
  const instruction = taskInstructionText(text);
  return actionable(instruction) && !/(?:完成|做完|写完)了[吗么？?]/.test(instruction);
}

// Parse only the edges of a creation request. Quoted title text is opaque so
// words such as “高优先级” inside a title do not become task metadata.
function taskCreation(input: string, now: Date): Create | null | undefined {
  const prefix = /^(?:请)?(?:麻烦你(?:帮我)?|请你|我想(?:让你|请你|要)?(?:帮我)?|你帮我|帮我|给我|为我)?(?:进行)?(?:记一下|记下|新建|新增|添加|创建)(?:一下)?[\s，,：:]*/;
  if (!prefix.test(input) || !(/任务|待办|清单|周计划|周目标/.test(input) || /^(?:请)?(?:(?:麻烦你|请你|我想|你帮我|帮我|给我|为我)|记一下|记下)/.test(input))) return;
  const titles: string[] = [];
  const masked = input.replace(/[“「『《"']([^“”「」『』《》"']+)[”」』》"']/g, (_, title: string) => {
    titles.push(title); return `\uE000${titles.length - 1}\uE001`;
  });
  const kind = kindOf(masked); const date = resolveTaskDate(masked, now) ?? taskListDate(now);
  let name = masked.replace(prefix, ''); let priority: LinkedTask['priority'] = 'medium'; let leadingPriority = false;
  const setPriority = (level: string) => { priority = ({ 高: 'high', 中: 'medium', 低: 'low' } as const)[level as '高' | '中' | '低']; };
  const priorityStart = /^(?:([高中低])\s*优先级|优先级\s*(?:(?:设置|设|调整|调|改)(?:为|成)|为|是|[:：])?\s*([高中低]))(?:的)?/;
  const priorityEnd = /[\s，,；;]*(?:(?:优先级\s*(?:(?:设置|设|调整|调|改)(?:为|成)|为|是|[:：])?\s*([高中低]))|(?:(?:(?:设置|设|调整|调|改)(?:为|成)|为)?\s*([高中低])\s*优先级))(?:的)?(?:每日任务|任务|待办)?$/;
  const end = priorityEnd.exec(name);
  if (end) { setPriority((end[1] ?? end[2])!); name = name.slice(0, end.index); }
  // Date, quantity, priority and type may occur in different orders.
  for (;;) {
    const before = name;
    name = name.replace(/^[\s，,：:]+/, '')
      .replace(/^(?:一个|一项|一条|个)(?=(?:大后天|后天|明天|今天|今日|昨天|高|中|低|优先级|每日任务|任务|待办|清单|本周|这周|下周|周计划|周目标))/, '')
      .replace(/^(?:大后天|后天|明天|今天|今日|昨天|(?:下|本|这)?周[一二三四五六日天]|\d{4}-\d{1,2}-\d{1,2})(?:的)?[\s，,：:]*/, '')
      .replace(/^(?:每日任务|本周计划|这周计划|下周计划|周计划|周目标|任务|待办|清单)(?:的)?[\s，,：:]*/, '')
      .replace(/^(?:名称(?:为|是)|名为|叫做|叫)[\s，,：:]*/, '');
    const start = priorityStart.exec(name);
    if (start) { if (!end) setPriority((start[1] ?? start[2])!); leadingPriority = true; name = name.slice(start[0].length); }
    if (before === name) break;
  }
  if (leadingPriority) name = name.replace(/(?:的)?(?:每日任务|任务|待办)$/, '');
  if (end && /^(?:一个|一项|一条|个)$/.test(name.trim())) name = '';
  name = name.replace(/^[\s，,：:]+|[\s，,；;]+$/g, '').replace(/\uE000(\d+)\uE001/g, (_, index: string) => titles[Number(index)]!).trim();
  return name && name.length <= 500 ? { type: 'create', kind, name, priority, date } : null;
}

export function localTaskCommand(text: string, now: Date): Command | undefined {
  if (!isInstruction(text) || actionQuestion(taskInstructionText(text))) return;
  const input = requestText(text);
  const kind = kindOf(input);
  const date = resolveTaskDate(input, now);
  const creation = taskCreation(input, now);
  if (creation !== undefined) return creation ?? undefined;
  const cancelReminder = /^(?:请)?(?:帮我)?(?:取消|关闭)(.+?)的?(?:到点)?提醒$/.exec(input);
  if (cancelReminder) return { type: 'update', kind: 'daily', target: cleanTarget(cancelReminder[1]!), patch: { reminderAt: null } };
  const reminderCreate = /^(?:请)?(?:帮我)?(.+?)提醒我[：:\s]*(.+)$/.exec(input);
  const reminderUpdate = /^(?:请)?(?:帮我)?(?:把|给|将)(.+?)(?:的提醒(?:时间)?(?:设为|改为)|设置(?:一个)?(?:提醒)?|设个提醒)[：:\s]*(.+)$/.exec(input);
  if (reminderCreate || reminderUpdate) {
    const time = reminderCreate?.[1] ?? reminderUpdate![2]!;
    const reminderAt = taskReminderTime(time, resolveTaskDate(time, now) ?? taskListDate(now), now);
    if (!reminderAt) return;
    if (reminderCreate) return { type: 'create', kind: 'daily', name: reminderCreate[2]!.trim(), priority: 'medium', date: taskListDate(new Date(reminderAt)), reminderAt };
    return { type: 'update', kind: 'daily', target: cleanTarget(reminderUpdate![1]!), patch: { reminderAt } };
  }
  const rename = /^(?:请)?(?:帮我)?(?:把|将)(.+?)(?:改名为|重命名为|改名叫|名称改为)[：:\s]*(.+)$/.exec(input);
  if (rename) return { type: 'update', kind, date, target: cleanTarget(rename[1]!), patch: { name: rename[2]!.trim() } };
  const move = /^(?:请)?(?:帮我)?(?:把|将)(.+?)(?:改到|移到|挪到|推迟到|安排到)(.+)$/.exec(input);
  if (move) {
    const next = resolveTaskDate(move[2]!, now);
    if (next && kind === 'daily') return { type: 'update', kind, target: cleanTarget(move[1]!), patch: { date: next } };
  }
  if (/^(?:我)?(?:已经)?(?:做完了|完成了|搞定了)$/.test(input)) return { type: 'update', kind, target: '这个', patch: { completed: true } };
  const priority = /^(?:请)?(?:帮我|给我)?(?:把|将)(.+?)(?:的)?(?:优先级)?(?:设为|改为|改成|设成|设置为|设置成|调整为|调整成|调为|转为|转成|转换为)(高|中|低)(?:优先级)?(?:吧)?$/.exec(input);
  if (priority) return { type: 'update', kind, date, target: cleanTarget(priority[1]!), patch: { priority: ({ 高: 'high', 中: 'medium', 低: 'low' } as const)[priority[2] as '高' | '中' | '低'] } };
  const mark = /^(?:请)?(?:帮我)?(?:把|将)(.+?)(?:标记(?:为|成)?|设为|改为|勾选为?)(未完成|已完成|完成)(?:了|吧)?$/.exec(input);
  const done = /^(?:请)?(?:帮我)?(?:完成|勾选)(?:了)?(?:任务|待办)?[：:\s]*(.+)$/.exec(input);
  const statement = /^(.+?)(?:已经|已)?(?:写完|做完|完成|搞定)(?:了|啦)$/.exec(input);
  const reported = /^(?:我)?(?:已经|刚刚|刚)?(?:完成|做完|写完)了(.+)$/.exec(input);
  if (mark || done || statement || reported) return { type: 'update', kind, date,
    target: cleanTarget((mark?.[1] ?? done?.[1] ?? statement?.[1] ?? reported?.[1])!), patch: { completed: mark?.[2] !== '未完成' } };
  return;
}

export async function interpretTaskCommand(config: AiConfig, text: string, now: Date): Promise<unknown> {
  const reply = await chatWithAi(config, [
    { role: 'system', content: [
      `只解析用户当前这句话对任务清单的操作，今天是北京时间 ${taskListDate(now)}，本周一 ${taskListWeek(now)}。只返回一个JSON对象，不执行动作，不返回解释。`,
      '新增格式：{"type":"create","kind":"daily","name":"交报告","date":"YYYY-MM-DD","priority":"medium"}。kind仅daily或weekly，只有明确周计划/周目标才weekly；优先级仅high/medium/low，未指定用medium；未指定日期用今天。标题保留用户要求的时间，不凭空新增提醒。',
      '修改格式：{"type":"update","kind":"daily","target":"原任务名称","date":"YYYY-MM-DD","patch":{"completed":true}}。date未指定则省略。patch仅name、priority、completed，可同时修改。恢复未完成用false。不要返回id、SQL、URL或凭证。',
      '用户只陈述情绪、询问方法、否定、假设、删除任务、移动日期、指代不明或缺少内容时，返回{"type":"none"}；不从引述内容推断操作。报告写完了可理解为完成“报告”。不要把“完成了吗”当成标记完成。',
      '任务专注开始：{"type":"focus","action":"start","target":"用户原文中的任务名或第一个","minutes":25}。只解析明确指令；不含任务名称时target为空；分钟为整数1～180，半小时30，一小时60，未说时长25。不创建新任务。',
      '专注控制：{"type":"focus","action":"pause"}；action还可resume/stop/retry/status，必须符合原文。拆目标：{"type":"plan","goal":"原文中的目标"}，只解析不创建。其他返回none。',
    ].join('\n') },
    { role: 'user', content: text },
  ], { temperature: 0, maxTokens: 350, timeoutMs: 8000 });
  try { return JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return undefined; }
}

function validateCommand(value: unknown, text: string, now: Date): Command | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  const kind = obj.kind === 'weekly' ? 'weekly' : obj.kind === 'daily' ? 'daily' : undefined;
  if (!kind || !isInstruction(text) || actionQuestion(taskInstructionText(text))) return;
  if (obj.type === 'create' && /记一下|记下|新建|新增|添加|创建|记到.*(?:清单|待办)|加到.*(?:清单|待办)|列入.*(?:清单|待办)|(?:帮我|给我)安排/.test(text)
    && typeof obj.name === 'string' && obj.name.trim() && obj.name.length <= 500 && validTaskDate(obj.date)
    && normalize(text).includes(normalize(obj.name))
    && ['high', 'medium', 'low'].includes(String(obj.priority))) {
    return { type: 'create', kind: kindOf(text), name: obj.name.trim(), date: resolveTaskDate(text, now) ?? taskListDate(now), priority: obj.priority as LinkedTask['priority'] };
  }
  if (obj.type === 'update' && /标记|勾选|改名|重命名|改为|改成|设为|转为|转成|调整|优先级|完成|写完|做完|搞定/.test(text)
    && typeof obj.target === 'string' && obj.target.trim() && obj.target.length <= 500
    && normalize(cleanTarget(obj.target)).length > 0 && normalize(text).includes(normalize(cleanTarget(obj.target)))
    && (obj.date === undefined || validTaskDate(obj.date)) && obj.patch && typeof obj.patch === 'object' && !Array.isArray(obj.patch)) {
    const patch = obj.patch as TaskListUpdateInput['patch'];
    if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['name', 'priority', 'completed'].includes(key))
      || (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 500))
      || (patch.priority !== undefined && !['high', 'medium', 'low'].includes(patch.priority))
      || (patch.completed !== undefined && typeof patch.completed !== 'boolean')) return;
    return { type: 'update', kind, target: obj.target.trim(), date: resolveTaskDate(text, now) ?? obj.date as string | undefined, patch };
  }
  return;
}

interface Options {
  interpret?: (text: string, now: Date) => Promise<unknown>;
  changed?: () => void;
  now?: () => Date;
  completed?: (item: LinkedTask, revision: number) => Promise<void>;
  companion?: TaskCompanion;
  plan?: (input: { goal: string; date: string }) => Promise<{ ai: boolean; items: TaskListCreateInput[] }>;
  beforeFocus?: () => void;
}

export class TaskListChat {
  private cards: ChatCard[] = [];
  private actions = new Map<string, { revision: number; expires: number; run: () => Promise<string> }>();
  private selected?: { item: LinkedTask; kind: TaskListKind; revision: number; expires: number };
  private pending?: { items: LinkedTask[]; command: TargetCommand; date?: string; revision: number; expires: number };
  private batch?: { items: TaskListCreateInput[]; saved: number; revision: number; expires: number };
  private retry?: { input: TaskListCreateInput; revision: number; expires: number; text: string };
  private shown?: { items: LinkedTask[]; kind: TaskListKind; date?: string; revision: number; expires: number };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  constructor(private readonly service: TaskListService, private readonly options: Options = {}) { this.now = options.now ?? (() => new Date()); }
  reset(): void { this.pending = this.retry = this.shown = undefined; this.batch = undefined; this.selected = undefined; this.actions.clear(); }

  rememberList(snapshot: TaskListSnapshot): void {
    this.shown = { items: snapshot.items, kind: snapshot.view === 'week' ? 'weekly' : 'daily', date: snapshot.view === 'pending' ? undefined : snapshot.date,
      revision: this.service.accountRevision(), expires: this.now().getTime() + 30 * 60_000 };
  }
  select(id: string, kind: TaskListKind): void {
    const context = this.shown;
    const item = context?.kind === kind && context.revision === this.service.accountRevision() ? context.items.find((entry) => entry.id === id) : undefined;
    if (!item) throw new Error('请刷新任务列表后重新选择。');
    this.selected = { item, kind, revision: this.service.accountRevision(), expires: this.now().getTime() + 30 * 60_000 };
  }
  private button(label: string, run: () => Promise<string>): { id: string; label: string } {
    for (const [id, entry] of this.actions) if (entry.expires < this.now().getTime()) this.actions.delete(id);
    if (this.actions.size > 300) this.actions.delete(this.actions.keys().next().value!);
    const id = randomUUID(); this.actions.set(id, { revision: this.service.accountRevision(), expires: this.now().getTime() + 30 * 60_000, run }); return { id, label };
  }
  private taskCard(item: LinkedTask, kind: TaskListKind, extra: NonNullable<ChatCard['actions']> = []): ChatCard {
    return { kind: 'task', title: item.name, taskId: item.id, state: 'saved', detail: `${taskListDate(new Date(item.createdAt))} · ${{ high: '高', medium: '中', low: '低' }[item.priority]}优先级 · ${item.completed ? '已完成' : '未完成'}${item.reminderAt ? ` · 提醒 ${new Date(Date.parse(item.reminderAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}` : ''} · 已同步`,
      actions: [...extra, ...(item.reminderAt && this.options.companion && !this.options.companion.status().preferences.reminders ? [this.button('用桌宠提醒', async () => { await this.options.companion!.configure({ ...this.options.companion!.status().preferences, reminders: true }); this.cards = [this.taskCard(item, kind)]; return '已将任务提醒交给桌宠，请保持桌宠运行。'; })] : []), this.button('选中这项', async () => { this.selected = { item, kind, revision: this.service.accountRevision(), expires: this.now().getTime() + 30 * 60_000 }; this.cards = [this.taskCard(item, kind)]; return `已选中“${item.name}”，接下来可以说“改到明天”“优先级改为高”或“做完了”。`; }),
        ...(!item.completed ? [this.button('完成', () => this.finish(item, { type: 'update', target: item.name, kind, patch: { completed: true } }, this.service.accountRevision())),
          ...(kind === 'daily' ? [this.button('专注25分钟', () => this.finish(item, { type: 'focus', action: 'start', target: item.name, kind: 'daily', minutes: 25 }, this.service.accountRevision()))] : [])] : [])] };
  }
  private decorate(): ChatCard[] {
    if (this.cards.length) return this.cards;
    const pending = this.pending;
    if (pending) return pending.items.map((item) => ({ kind: 'choice', title: item.name, state: 'pending', detail: `${taskListDate(new Date(item.createdAt))} · ${item.completed ? '已完成' : '未完成'}`,
      actions: [this.button('选择这项', async () => {
        if (this.pending !== pending || pending.expires < this.now().getTime()) return '这份选择已失效，请重新操作。';
        const reply = await this.finish(item, pending.command, pending.revision); this.pending = undefined; return reply;
      })] }));
    if (this.batch) {
      const batch = this.batch;
      return [{ kind: 'preview', title: '核对后保存', state: 'pending', detail: batch.items.map((item) => `${item.date} · ${item.name}`).join('\n'),
        actions: [this.button('确认添加', () => this.batch === batch ? this.handle('确认添加').then((reply) => reply!) : Promise.resolve('这份预览已失效。')), this.button('取消', async () => { if (this.batch === batch) this.batch = undefined; return '已取消尚未保存的预览。'; })] }];
    }
    return [];
  }
  private activeTaskName(): string | null {
    return this.selected?.revision === this.service.accountRevision() && this.selected.expires > this.now().getTime() ? this.selected.item.name : null;
  }
  turn(text: string): Promise<ChatMessage | undefined> {
    const revision = this.service.accountRevision();
    const result = this.queue.then(async () => {
      this.cards = [];
      const content = this.service.accountRevision() === revision ? await this.handle(text.trim()) : '清单账号已切换，请重新操作。';
      return content === undefined ? undefined : { role: 'assistant' as const, source: 'task' as const, content, cards: this.decorate(), activeTaskName: this.activeTaskName() };
    });
    this.queue = result.catch(() => {}); return result;
  }
  act(id: string): Promise<ChatMessage> {
    const result = this.queue.then(async () => {
      this.cards = []; const entry = this.actions.get(id); this.actions.delete(id);
      if (!entry || entry.expires < this.now().getTime() || entry.revision !== this.service.accountRevision()) return { role: 'assistant' as const, source: 'task' as const, content: '操作已失效，请重新查询任务后操作。' };
      try { const content = await entry.run(); return { role: 'assistant' as const, source: 'task' as const, content, cards: this.decorate(), activeTaskName: this.activeTaskName() }; }
      catch (error) {
        const content = error instanceof Error ? error.message : '操作失败，请重试。';
        return { role: 'assistant' as const, source: 'task' as const, content, activeTaskName: this.activeTaskName(), cards: this.cards.length ? this.cards : [{ kind: 'error' as const, title: '操作结果尚未确认', detail: `${content}\n请重新查询当前状态后再操作。`, state: 'failed' as const }] };
      }
    });
    this.queue = result.catch(() => {}); return result;
  }

  reply(text: string): Promise<string | undefined> {
    return this.turn(text).then((reply) => reply?.content);
  }

  private async finish(item: LinkedTask, command: TargetCommand, revision: number): Promise<string> {
    this.selected = { item, kind: command.kind, revision, expires: this.now().getTime() + 30 * 60_000 };
    if (command.type === 'focus') {
      if (!this.options.companion) return '任务专注暂不可用。';
      if (item.completed) return '这个任务已完成，请选择未完成的每日任务。';
      this.options.beforeFocus?.();
      const status = await this.options.companion.focus({ action: 'start', id: item.id, minutes: command.minutes }, revision);
      this.options.changed?.();
      this.cards = [{ kind: 'focus', title: status.name ?? item.name, state: 'saved', detail: `专注 ${command.minutes} 分钟 · ${status.phase === 'running' ? '计时中' : '已暂停'}，我会安静陪你。` }];
      return status.phase === 'running' ? `已开始专注“${status.name}”，本轮 ${command.minutes} 分钟。\n可以说“暂停一下”“继续专注”“结束计时”或“专注还剩多久”。` : '计时已建立但处于暂停状态，请说“继续专注”。';
    }
    let saved: LinkedTask;
    try { saved = await this.service.update({ id: item.id, kind: command.kind, patch: command.patch,
      ...(item.updatedAt ? { expectedUpdatedAt: item.updatedAt } : {}) }, revision); }
    catch (error) {
      this.cards = [{ kind: 'error', title: '修改结果尚未确认', state: 'failed', detail: '请先查询当前状态，避免覆盖其他端的修改。', actions: [this.button('查看当前状态', async () => {
        const snapshot = await this.service.list(command.kind === 'weekly' ? 'week' : 'pending', revision);
        const latest = snapshot.items.find((entry) => entry.id === item.id) ?? (command.kind === 'daily' ? await this.service.getDaily(item.id, revision) : undefined);
        this.cards = latest ? [this.taskCard(latest, command.kind)] : []; return latest ? '已读取任务的当前状态。' : '这项任务暂不可用，请打开完整清单核对。';
      })] }]; throw error;
    }
    this.selected = { item: saved, kind: command.kind, revision, expires: this.now().getTime() + 30 * 60_000 };
    const inverse: TaskListUpdateInput['patch'] = {};
    for (const key of Object.keys(command.patch) as Array<keyof TaskListUpdateInput['patch']>) {
      if (key === 'date') inverse.date = taskListDate(new Date(item.createdAt));
      else Object.assign(inverse, { [key]: item[key] });
    }
    this.cards = [this.taskCard(saved, command.kind, [this.button('撤销修改', async () => {
      const restored = await this.service.update({ id: saved.id, kind: command.kind, patch: inverse, ...(saved.updatedAt ? { expectedUpdatedAt: saved.updatedAt } : {}) }, revision);
      this.selected = { item: restored, kind: command.kind, revision, expires: this.now().getTime() + 30 * 60_000 };
      this.cards = [this.taskCard(restored, command.kind)]; this.options.changed?.(); return `已撤销对“${saved.name}”的修改。`;
    })])];
    // Keep the displayed order/IDs stable even after changing priority or
    // completion; refresh only this task's optimistic concurrency token.
    if (this.shown?.kind === command.kind && this.shown.revision === revision) this.shown.items = this.shown.items.map((entry) => entry.id === saved.id ? saved : entry);
    this.options.changed?.();
    if (command.patch.completed === true && !item.completed) await this.options.completed?.(saved, revision).catch(() => {});
    const changes = [command.patch.date ? `已改到${command.patch.date}` : '', command.patch.name !== undefined ? '已改名' : '', command.patch.priority !== undefined ? `优先级已改为${{ high: '高', medium: '中', low: '低' }[command.patch.priority]}` : '', command.patch.completed !== undefined ? (command.patch.completed ? '已标记完成' : '已恢复未完成') : '', command.patch.reminderAt !== undefined ? (command.patch.reminderAt ? '已设置到点提醒' : '已取消到点提醒') : ''].filter(Boolean).join('，');
    return `“${saved.name}”${changes}。${command.patch.reminderAt ? this.reminderReceipt(command.patch.reminderAt) : ''}`;
  }

  private async create(input: TaskListCreateInput, revision: number): Promise<string> {
    const saved = await this.service.create(input, revision);
    this.retry = undefined;
    this.options.changed?.();
    this.selected = { item: saved, kind: input.kind, revision, expires: this.now().getTime() + 30 * 60_000 };
    this.cards = [this.taskCard(saved, input.kind)];
    return `已添加${input.kind === 'weekly' ? '周计划' : '任务'}：“${saved.name}”。\n${input.kind === 'weekly' ? '所属周日期' : '任务日期'}：${input.date}，${{ high: '高', medium: '中', low: '低' }[saved.priority]}优先级。${input.reminderAt ? this.reminderReceipt(input.reminderAt) : ''}`;
  }

  private reminderReceipt(at: string): string {
    const enabled = this.options.companion?.status().preferences.reminders;
    return `\n提醒时间：${new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）。${enabled ? '桌宠运行时生效，免打扰期间延后。' : '桌宠到点提醒尚未开启，可说“开启到点提醒”。'}`;
  }

  private async companionReply(intent: Exclude<CompanionIntent, { type: 'focus'; action: 'start' }>, text: string, revision: number, expires: number): Promise<string> {
    const companion = this.options.companion;
    if (!companion) return '清单联动暂不可用。';
    if (intent.type === 'suggest') {
      const snapshot = await this.service.list('today', revision);
      const item = snapshot.items.find((item) => !item.completed);
      if (!item) return '今天没有未完成任务。可以放松一下，或告诉我想记什么。';
      this.selected = { item, kind: 'daily', revision, expires };
      this.cards = [this.taskCard(item, 'daily', [this.button('先做5分钟', () => this.finish(item, { type: 'focus', action: 'start', kind: 'daily', target: item.name, minutes: 5 }, revision))])];
      return `先从“${item.name}”开始吧，试着做 5 分钟，迈出第一步就好。`;
    }
    if (intent.type === 'focus') {
      const status = intent.action === 'status' ? companion.status().focus : await companion.focus({ action: intent.action }, revision);
      this.options.changed?.();
      if (intent.action === 'stop') return '本轮专注已结束，进度已保存。';
      if (status.phase === 'idle') return '当前没有任务专注。可以说“专注写报告25分钟”。';
      return `“${status.name}”${status.phase === 'running' ? '正在专注' : '已暂停'}，本轮剩余 ${Math.floor(status.remaining / 60)} 分 ${status.remaining % 60} 秒。${status.error ? `\n${status.error}` : ''}`;
    }
    if (intent.type === 'briefing') {
      const snapshot = await this.service.list('today', revision);
      this.pending = undefined;
      this.shown = { items: snapshot.items.filter((item) => !item.completed).slice(0, 5), kind: 'daily', date: snapshot.date, revision, expires };
      return briefingText(snapshot, intent.kind === 'evening');
    }
    if (intent.type === 'configure') {
      const prefs = await companion.configure({ ...companion.status().preferences, ...intent.patch }, revision);
      this.options.changed?.();
      return `设置已保存：到点提醒${prefs.reminders ? '开启' : '关闭'}；每日简报${prefs.morning ? prefs.morningTime : '关闭'}；晚间复盘${prefs.evening ? prefs.eveningTime : '关闭'}；免打扰${prefs.quiet ? `${prefs.quietStart}～${prefs.quietEnd}` : '关闭'}（北京时间）。`;
    }
    let items: TaskListCreateInput[]; let title: string;
    if (intent.type === 'plan') {
      if (!this.options.plan) return '目标拆解暂不可用。';
      const result = await this.options.plan({ goal: intent.goal, date: resolveTaskDate(text, this.now()) ?? taskListDate(this.now()) });
      items = result.items; title = result.ai ? 'AI 拆解预览（尚未保存）' : '通用步骤预览（未启用 AI，尚未保存）';
    } else {
      const today = taskListDate(this.now());
      const tomorrow = taskListDate(new Date(new Date(`${today}T12:00:00+08:00`).getTime() + 86400_000));
      items = await this.service.rollover(/明天/.test(text) ? tomorrow : today, revision);
      if (!items.length) return '没有需要接续的未完成任务，已经接续过的不会重复添加。';
      title = '任务接续预览（创建副本，保留原记录；同一任务同一天只接续一次）';
    }
    if (this.service.accountRevision() !== revision) return '账号已切换，预览已取消。';
    this.batch = { items, saved: 0, revision, expires };
    return [title, ...items.map((item, i) => `${i + 1}. ${item.date} · ${item.name}`), '回复“确认添加”保存以上全部任务，或“取消”。也可到清单页手动编辑。'].join('\n');
  }

  private async handle(text: string): Promise<string | undefined> {
    const revision = this.service.accountRevision();
    const timestamp = this.now().getTime();
    const expires = timestamp + 5 * 60_000;
    const choice = taskOrdinal(text, true);
    try {
      if (/^(?:取消|算了|不改了|不加了)$/.test(text) && (this.pending || this.retry || this.batch)) {
        const saved = this.batch?.saved ?? 0; this.reset(); return `已取消尚未执行的操作。${saved ? `已保存的 ${saved} 项保持不变。` : ''}`;
      }
      if (this.batch && /^(?:确认|确认添加|确认保存|重试|再试一次)[。！!]*$/.test(text)) {
        const batch = this.batch;
        if (batch.revision !== revision || batch.expires < timestamp) { this.batch = undefined; return '预览已失效，请重新生成；已保存的任务不会撤销。'; }
        for (; batch.saved < batch.items.length; batch.saved++) {
          await this.service.create(batch.items[batch.saved]!, revision);
          this.options.changed?.();
        }
        this.batch = undefined;
        return `已将 ${batch.items.length} 项任务保存到清单对应日期。原任务保持不变。`;
      }
      if (this.batch && /^(?:确认|重试)/.test(text)) {
        const control = localCompanionIntent(text);
        if (control && ((control.type === 'focus' && control.action !== 'start') || control.type === 'briefing')) {
          return await this.companionReply(control, text, revision, expires);
        }
        return '还有一份待确认预览，请先回复“确认添加”或“取消”。';
      }
      if (this.pending && (choice !== undefined || /^(?:确认|确认修改|就是这项|就是这个)[。！!]*$/.test(text))) {
        const pending = this.pending;
        if (pending.revision !== revision || pending.expires < timestamp) { this.reset(); return '之前的选择已失效，请重新说一下要修改哪项任务。'; }
        const selected = pending.items[(choice ?? (pending.items.length === 1 ? 1 : 0)) - 1];
        if (!selected) return `请选择第 1～${pending.items.length} 项，或回复“取消”。`;
        const result = await this.finish(selected, pending.command, revision);
        this.pending = undefined;
        return result;
      }
      if (this.retry && (/^(?:重试|重新保存|再试一次)$/.test(text) || this.retry.text === text)) {
        if (this.retry.revision !== revision || this.retry.expires < timestamp) { this.retry = undefined; return '上次新增操作已失效，请重新输入任务。'; }
        return await this.create(this.retry.input, revision);
      }
      if (choice !== undefined) return '当前没有待选择的任务。请先说要对哪项任务做什么，例如“专注第1项25分钟”。';
      if (/^(?:确认|确认添加|确认保存|重试|重新保存|再试一次)[。！!]*$/.test(text)) return '当前没有待确认或待重试的清单操作，没有新增任务。';
      const current = this.selected?.revision === revision && this.selected.expires > timestamp ? this.selected : undefined;
      const contextual = current && /^(?:改到|移到|挪到|优先级改为|改成|改为)/.test(requestText(text)) ? `把这个任务${requestText(text)}` : text;
      const directTask = localTaskCommand(contextual, this.now());
      if (!directTask && isInstruction(text) && !actionQuestion(taskInstructionText(text)) && taskCreation(requestText(text), this.now()) === null) return '还缺少任务名称，请说“新增高优先级任务：提交报告”。';
      const candidateCompanion = !directTask && (companionCandidate(text) || /^(?:请)?(?:帮我)?(?:先)?(?:暂停|继续)(?:一下|下)?[。！!]*$/.test(text));
      if (candidateCompanion && !actionable(text)) return '这句话没有按操作执行。可以直接说“专注写报告25分钟”或“帮我拆解周目标：完成报告”。';
      let intent = candidateCompanion ? localCompanionIntent(text) : undefined;
      const query = parseTaskListQuery(text);
      const fallback = !intent ? directTask : undefined;
      if (!fallback && /提醒我|(?:把|给|将).*(?:提醒时间|设置.*提醒|设个提醒)/.test(text)) return '没有设置提醒。请给出明确且未过期的北京时间，例如“明天下午三点提醒我交报告”或“把交报告的提醒改为明天15:00”。';
      const needsAi = !intent || (intent.type === 'focus' && intent.action === 'start' && /这件事|帮我|给我|为我|麻烦|启动|设置|开个|一下/.test(intent.target));
      if (candidateCompanion && needsAi && !fallback && this.options.interpret) {
        try { intent = validateCompanionIntent(await this.options.interpret(text, this.now()), text) ?? intent; } catch { /* deterministic fallback */ }
      }
      if (intent) {
        const free = intent.type === 'focus' && intent.action === 'start' && /^(?:自由专注|自由|不关联任务)$/.test(intent.target);
        if (free && intent.type === 'focus' && intent.action === 'start' && this.options.companion) {
          const status = await this.options.companion.focus({ action: 'start', minutes: intent.minutes }, revision);
          this.cards = [{ kind: 'focus', title: '自由专注', state: 'saved', detail: `${intent.minutes} 分钟 · ${status.phase === 'running' ? '计时中' : '已暂停'}` }];
          this.options.changed?.(); return `已开始自由专注 ${intent.minutes} 分钟，我会安静陪你。`;
        }
        if (!this.service.status().connected && !(intent.type === 'focus' && intent.action !== 'start') && intent.type !== 'configure') return '请先在“今天”页右上角连接原清单账号。';
        if (this.service.accountRevision() !== revision) return '清单账号已切换，请重新操作。';
        this.retry = undefined;
        if (intent.type !== 'focus' || intent.action !== 'start') return await this.companionReply(intent, text, revision, expires);
        if (!Number.isInteger(intent.minutes) || intent.minutes < 1 || intent.minutes > 180) return '专注时长应为 1～180 分钟。';
      } else if (candidateCompanion && !fallback) return '没有执行操作。可以说“专注写报告25分钟”“暂停一下”“总结一下今天”或“拆解周目标：完成报告”。';
      const readOnlyQuestion = !isInstruction(text) && /任务|待办|清单|报告/.test(text);
      if (readOnlyQuestion) return '查询可以说“今天有哪些任务”；新增可以说“添加任务：交报告”；完成可以说“把交报告标记完成”。';
      if (query && query !== 'unsupported' && !fallback && !intent) {
        this.pending = undefined;
        const date = resolveTaskDate(text, this.now());
        const view = query === 'week' ? 'week' : date ? 'today' : query;
        const snapshot = await this.service.list(view, revision, view === 'week' && date ? taskListWeek(new Date(`${date}T12:00:00+08:00`)) : date);
        this.shown = { items: snapshot.items.filter((item) => !item.completed).slice(0, 5), kind: view === 'week' ? 'weekly' : 'daily', date: snapshot.view === 'pending' ? undefined : snapshot.date, revision, expires };
        this.cards = this.shown.items.map((item) => this.taskCard(item, this.shown!.kind));
        return formatTaskListReply(snapshot, taskListDate(this.now()));
      }
      const candidate = Boolean(intent) || Boolean(fallback) || query === 'unsupported' || /(?:记到|加到|列入).*(?:清单|待办)|(?:帮我|给我)安排|^(?:请)?(?:帮我|给我)?(?:记一下|记下|新建|新增|添加|创建).*(?:任务|待办|报告|清单)|(?:把|将).*(?:标记|勾选|改名|重命名|改为|改成|设为|调整|优先级)|(?:写完|做完|完成|搞定)(?:了|啦)?[。！!]*$/.test(text);
      if (!candidate) return;
      if (fallback?.type !== 'create' && /^(?:请)?(?:帮我|给我)?(?:删除|移除)|(?:把|将).*(?:删除|移除)/.test(text)) return '删除任务请打开网页版完整清单；这里可以改日期、修改内容或标记完成。';
      if (!this.service.status().connected) return '请先点击“清单”页右上角的“连接账号”，用原清单用户名登录。';
      const explicitDate = /\d{4}-\d{1,2}-\d{1,2}/.exec(text)?.[0];
      if (explicitDate && !resolveTaskDate(text, this.now())) return '这个日期不存在，请换一个有效日期。';
      let command: Command | FocusCommand | undefined = intent?.type === 'focus' && intent.action === 'start' ? { ...intent, kind: 'daily', date: resolveTaskDate(text, this.now()) } : fallback;
      if (!command && this.options.interpret) {
        try { command = validateCommand(await this.options.interpret(text, this.now()), text, this.now()) ?? fallback; } catch { /* local commands remain usable offline */ }
      }
      if (!command) return '请补充具体任务名称，例如“添加任务：交报告”或“把交报告标记完成”。';
      if (this.service.accountRevision() !== revision) return '清单账号已切换，请重新操作。';
      this.retry = undefined;
      if (command.type === 'create') {
        this.pending = undefined;
        if (command.reminderAt) {
          const pool = await this.service.list('pending', revision);
          const matched = rankTaskTargets(pool.items, command.name);
          if (matched.items.length) {
            const update: Update = { type: 'update', kind: 'daily', target: command.name, patch: { reminderAt: command.reminderAt } };
            if (matched.exact && matched.items.length === 1) return this.finish(matched.items[0]!, update, revision);
            this.pending = { items: matched.items.slice(0, 8), command: update, revision, expires };
            return '找到已有任务，请点选要设置提醒的那一项。';
          }
        }
        const { type: _type, ...fields } = command;
        const input = { ...fields, id: randomUUID() };
        this.retry = { input, revision, expires, text };
        return await this.create(input, revision);
      }
      if (/^(?:这个|这项|这条|那个|那项|刚才那个|刚才的|它)(?:任务|待办)?$/.test(command.target)) {
        const focus = this.options.companion?.status().focus;
        const selected = current ?? (focus?.taskId && !focus.free ? { item: await this.service.getDaily(focus.taskId, revision), kind: 'daily' as const } : undefined);
        if (!selected) return '还没有选中的任务，请先点击一张任务卡片，或告诉我任务名称。';
        return this.finish(selected.item, { ...command, kind: selected.kind } as TargetCommand, revision);
      }
      if (command.type === 'focus' && !command.target) {
        const snapshot = await this.service.list('today', revision);
        const items = snapshot.items.filter((item) => !item.completed);
        if (!items.length) return '今天没有未完成的每日任务。请先添加任务，再开启专注。';
        if (items.length === 1) return await this.finish(items[0]!, command, revision);
        this.shown = { items: items.slice(0, 8), kind: 'daily', date: snapshot.date, revision, expires };
        this.pending = { items: items.slice(0, 8), command, date: snapshot.date, revision, expires };
        return ['要专注哪项任务？', ...items.slice(0, 8).map((item, i) => `${i + 1}. ${item.name}`), '回复序号选择，或“取消”。'].join('\n');
      }
      const quoted = quotedTaskTarget(text);
      const numbered = quoted && normalize(quoted) === normalize(command.target) ? undefined : taskOrdinal(command.target);
      if (numbered !== undefined) {
        // A candidate list is newer than the previous query. Never interpret
        // its “second task” using an older unrelated list.
        const context = this.pending ? { ...this.pending, kind: this.pending.command.kind } : this.shown;
        if (context) {
          if (context.revision !== revision || context.expires < timestamp) { this.pending = undefined; this.shown = undefined; return '之前的任务序号已失效，请重新查询后再操作。'; }
          const explicitKind = /周计划|周目标|(?:本周|这周|下周).*(?:任务|计划)|每日任务|今日任务/.test(text);
          if (command.type === 'update' && !explicitKind && !command.date) command = { ...command, kind: context.kind };
          const shownDate = 'date' in context ? context.date : undefined;
          const requestedDate = command.date && command.kind === 'weekly' ? taskListWeek(new Date(`${command.date}T12:00:00+08:00`)) : command.date;
          if (context.kind !== command.kind || (requestedDate && requestedDate !== shownDate)) return '这次说的日期或任务类型与刚才列表不一致，请先查询对应清单，避免改错任务。';
          const selected = context.items[numbered - 1];
          if (!selected) return `刚才只列出了 ${context.items.length} 项，请选择显示过的序号，或重新查询任务。`;
          const result = await this.finish(selected, command, revision); this.pending = undefined; return result;
        }
        const day = command.kind === 'weekly' && command.date ? taskListWeek(new Date(`${command.date}T12:00:00+08:00`)) : command.date;
        const snapshot = await this.service.list(command.kind === 'weekly' ? 'week' : 'today', revision, day);
        const available = snapshot.items.filter((item) => !item.completed); const items = available.slice(0, 8);
        if (!items[numbered - 1]) return available[numbered - 1] ? '首次预览最多显示 8 项，请补充任务名称关键词，避免按未展示的序号操作。' : `当前${command.kind === 'weekly' ? '本周' : '当日'}只有 ${available.length} 项可选的未完成任务，没有第 ${numbered} 项。请先查询对应清单。`;
        this.shown = { items, kind: command.kind, date: snapshot.date, revision, expires };
        this.pending = { items, command, date: snapshot.date, revision, expires };
        return [`还没有最近一次的任务列表，先按${command.kind === 'weekly' ? '本周' : snapshot.date}未完成任务列出：`, ...items.map((item, i) => `${i + 1}. ${item.name}`), `你指第 ${numbered} 项“${items[numbered - 1]!.name}”吗？尚未修改，回复“第${numbered}项任务”确认，或“取消”。`].join('\n');
      }
      this.pending = undefined;
      const target = normalize(command.target);
      if (!target) return '请说出要修改的任务名称。';
      const snapshot = await this.service.list(command.kind === 'weekly' ? 'week' : 'today', revision,
        command.date ? (command.kind === 'weekly' ? taskListWeek(new Date(`${command.date}T12:00:00+08:00`)) : command.date) : undefined);
      let pool = snapshot.items;
      if (command.kind === 'daily' && !command.date) {
        const pending = await this.service.list('pending', revision);
        pool = [...new Map([...pool, ...pending.items].map((item) => [item.id, item])).values()];
      }
      const matched = rankTaskTargets(pool, command.target); const candidates = matched.items;
      if (!candidates.length) {
        const suggestions = pool.filter((item) => !item.completed).slice(0, 5);
        if (!suggestions.length) return `没有找到“${command.target}”。可以补充名称关键词或任务日期。`;
        this.shown = { items: suggestions, kind: command.kind, date: command.date ? snapshot.date : undefined, revision, expires };
        return [`没有找到与“${command.target}”足够接近的任务，尚未修改。当前可选的未完成任务：`, ...suggestions.map((item, i) => `${i + 1}. ${item.name}（${taskListDate(new Date(item.createdAt))}）`), '可以说“把第2项任务改为高优先级”，或补充名称关键词。'].join('\n');
      }
      if (candidates.length === 1 && matched.exact) return await this.finish(candidates[0]!, command, revision);
      if (candidates.length > 8) return `找到 ${candidates.length} 项相关任务，请补充更完整的名称或日期。`;
      this.shown = { items: candidates, kind: command.kind, date: command.date ? snapshot.date : undefined, revision, expires };
      this.pending = { items: candidates, command, date: this.shown.date, revision, expires };
      return [`找到 ${candidates.length} 项相关任务，请选择：`, ...candidates.map((item, index) => `${index + 1}. ${item.name}（${taskListDate(new Date(item.createdAt))}，${item.completed ? '已完成' : '未完成'}）`), '回复“第1项”等序号执行，或回复“取消”。'].join('\n');
    } catch (error) {
      const content = error instanceof Error ? error.message : '任务操作失败，请稍后重试。';
      if (!this.cards.length) this.cards = [{ kind: 'error', title: '结果尚未确认', detail: content, state: 'failed', ...(this.retry || this.batch ? { actions: [this.button('重试保存', async () => (await this.handle('重试'))!)] } : {}) }];
      return `${content}${this.retry || this.batch ? '\n可以回复“重试”，沿用原任务编号，不会重复创建；已保存部分保持不变。' : ''}`;
    }
  }
}
