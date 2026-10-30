import type { ReminderRepeat } from '../shared/contracts';
import { actionable, actionQuestion, requestText, taskReminderTime } from './task-chat-intents';
import { resolveTaskDate } from './task-list-chat';
import { taskListDate } from './task-list';

// Repeating personal reminders remain local. A connected one-shot reminder is
// routed to the task service, so the same request never writes two stores.
export function personalReminder(text: string, now: Date, connected: boolean): { text: string; dueAt: string; repeat: ReminderRepeat } | undefined {
  if (!actionable(text) || actionQuestion(text)) return;
  const input = requestText(text).replace(/^(?:请)?(?:帮我|给我)?/, '');
  const match = /^(.*?)提醒我[：:\s]*(.+)$/.exec(input);
  if (!match) return;
  const repeat: ReminderRepeat = /每天/.test(match[1]!) ? 'daily' : /工作日|每个工作日/.test(match[1]!) ? 'weekdays' : 'none';
  if (repeat === 'none' && connected) return;
  const time = match[1]!.replace(/每天|每个工作日|工作日/g, '');
  let dueAt = taskReminderTime(time, resolveTaskDate(time, now) ?? taskListDate(now), now);
  if (!dueAt && repeat !== 'none') {
    const tomorrow = taskListDate(new Date(now.getTime() + 86400_000));
    dueAt = taskReminderTime(time, tomorrow, now);
  }
  if (!dueAt) return;
  let at = new Date(dueAt);
  if (repeat === 'weekdays') {
    while ([0, 6].includes(new Date(at.getTime() + 8 * 3600_000).getUTCDay())) at = new Date(at.getTime() + 86400_000);
  }
  return { text: match[2]!.trim(), dueAt: at.toISOString(), repeat };
}
