// AI 聊天动作协议：约定 AI 在回复末尾输出特定标记，即可直接创建提醒。
// 主进程解析并执行动作，标记行不会展示给用户，也不会进入聊天历史。
import type { ReminderRepeat } from '../shared/contracts';

export const AI_ACTION_MARKER = '【设定提醒】';
const DUE_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_ACTION_TEXT_LENGTH = 200;

export interface AiReminderAction {
  text: string;
  dueAt: string;
  repeat: ReminderRepeat;
}

// 写入 system prompt 的动作协议说明。
export function aiReminderPromptLines(): string[] {
  return [
    `如果用户想让你"定时/提醒/别忘了他要做某事"，请先用一句话简短答应，然后在回复的最后一行原样输出（不要解释、不要用代码块包裹、不要截断）：`,
    `${AI_ACTION_MARKER}{"text":"提醒内容","dueAt":"YYYY-MM-DDTHH:mm","repeat":"none"}`,
    'dueAt 用24小时制本地时间，例如 2026-09-06T08:30 表示9月6日早上8点半；repeat 只能是 none（单次）、daily（每天）、weekdays（工作日）之一；如果没有明确说重复，就用 none。用户没有让你设定提醒时，绝对不要输出这一行。',
  ];
}

// 从过去时间滚动到下一个未来时点；nextRepeatDueAt 的 800 次守卫只够约 2.2 年，
// AI 可能给出更久远的日期，这里用更大的循环并兜底到 1 分钟后。
function rollForwardDueAt(dueAt: string, repeat: Exclude<ReminderRepeat, 'none'>, now: number): string {
  const due = new Date(dueAt);
  for (let guard = 0; guard < 4000; guard += 1) {
    due.setDate(due.getDate() + 1);
    if (due.getTime() <= now) continue;
    if (repeat === 'weekdays') {
      const day = due.getDay();
      if (day === 0 || day === 6) continue;
    }
    return due.toISOString();
  }
  return new Date(now + 60_000).toISOString();
}

export function parseAiReminderAction(reply: string): AiReminderAction | undefined {
  const index = reply.lastIndexOf(AI_ACTION_MARKER);
  if (index < 0) return undefined;
  const tail = reply.slice(index + AI_ACTION_MARKER.length);
  const match = /(\{[\s\S]*\})/.exec(tail);
  const json = match?.[1];
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string' || !obj.text.trim()) return undefined;
  const text = obj.text.trim().slice(0, MAX_ACTION_TEXT_LENGTH);
  if (typeof obj.dueAt !== 'string' || !DUE_AT_PATTERN.test(obj.dueAt)) return undefined;
  const due = new Date(obj.dueAt);
  if (!Number.isFinite(due.getTime())) return undefined;
  const repeat: ReminderRepeat = obj.repeat === 'daily' || obj.repeat === 'weekdays' || obj.repeat === 'none' ? obj.repeat : 'none';
  const now = Date.now();
  let dueAt = obj.dueAt;
  if (due.getTime() <= now) {
    // 过去时间：单次提醒视为无效；重复提醒滚动到下一个周期，避免立即触发。
    if (repeat === 'none') return undefined;
    dueAt = rollForwardDueAt(dueAt, repeat, now);
  }
  return { text, dueAt, repeat };
}

// 从回复中移除动作标记行，只保留给用户看的部分；若移除后为空则返回空串由调用方兜底。
export function stripAiReminderAction(reply: string): string {
  const index = reply.lastIndexOf(AI_ACTION_MARKER);
  if (index < 0) return reply;
  return reply.slice(0, index).replace(/\s+$/, '');
}
