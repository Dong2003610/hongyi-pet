import type { Reminder, ReminderRepeat, Settings } from '../shared/contracts';

export interface PersistedStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  totalCompanionMs: number;
  lastInteractionDate: string;
  lastInteractionAt?: number;
}

export const MAX_TIMER_DELAY_MS = 2_147_000_000;
export const PET_SCALES = [0.5, 0.6, 0.8, 1, 1.2, 1.5] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function optionalBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (obj[key] === undefined) return fallback;
  if (typeof obj[key] !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
  return obj[key] as boolean;
}

function optionalInt(obj: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  if (obj[key] === undefined) return undefined;
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`Invalid settings field: ${key}`);
  }
  return value;
}

export function parseSettings(value: unknown): Settings {
  const obj = record(value, 'settings');
  const expected = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough', 'petScale', 'displayName', 'openAtLogin', 'soundEnabled', 'sedentaryReminder', 'pomodoroWorkMin', 'pomodoroBreakMin']);
  for (const key of Object.keys(obj)) if (!expected.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
  for (const key of ['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough'] as const) {
    if (typeof obj[key] !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
  }
  if (typeof obj.petScale !== 'number' || !Number.isFinite(obj.petScale) || !PET_SCALES.includes(obj.petScale as typeof PET_SCALES[number])) {
    throw new TypeError('Invalid settings field: petScale');
  }
  const displayName = typeof obj.displayName === 'string' && obj.displayName.length > 0 && obj.displayName.length <= 50
    ? obj.displayName
    : undefined;
  const result: Settings = {
    edgeSnap: obj.edgeSnap as boolean,
    alwaysOnTop: obj.alwaysOnTop as boolean,
    typingReaction: obj.typingReaction as boolean,
    clickThrough: obj.clickThrough as boolean,
    petScale: obj.petScale,
    openAtLogin: optionalBool(obj, 'openAtLogin', false),
    soundEnabled: optionalBool(obj, 'soundEnabled', true),
    sedentaryReminder: optionalBool(obj, 'sedentaryReminder', true),
  };
  if (displayName !== undefined) result.displayName = displayName;
  const pomodoroWorkMin = optionalInt(obj, 'pomodoroWorkMin', 5, 180);
  if (pomodoroWorkMin !== undefined) result.pomodoroWorkMin = pomodoroWorkMin;
  const pomodoroBreakMin = optionalInt(obj, 'pomodoroBreakMin', 1, 60);
  if (pomodoroBreakMin !== undefined) result.pomodoroBreakMin = pomodoroBreakMin;
  return result;
}

export function parsePersistedStats(value: unknown): PersistedStats {
  const obj = record(value, 'stats');
  const finite = (key: keyof PersistedStats, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const item = obj[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max) throw new TypeError(`Invalid stats field: ${key}`);
    return item;
  };
  const lastInteractionDate = obj.lastInteractionDate;
  if (typeof lastInteractionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastInteractionDate)) {
    throw new TypeError('Invalid stats field: lastInteractionDate');
  }
  const todayInteractions = finite('todayInteractions', 0);
  if (!Number.isInteger(todayInteractions)) throw new TypeError('Invalid stats field: todayInteractions');
  const lastInteractionAt = obj.lastInteractionAt;
  const parsed: PersistedStats = {
    affection: finite('affection', 0, 300),
    mood: finite('mood', 0, 100),
    todayInteractions,
    totalCompanionMs: finite('totalCompanionMs', 0),
    lastInteractionDate,
  };
  if (typeof lastInteractionAt === 'number' && Number.isFinite(lastInteractionAt) && lastInteractionAt >= 0) {
    parsed.lastInteractionAt = lastInteractionAt;
  }
  return parsed;
}

export function parseReminders(value: unknown): Reminder[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid reminders');
  return value.map((item) => {
    const obj = record(item, 'reminder');
    if (typeof obj.id !== 'string' || obj.id.length < 1 || obj.id.length > 100) throw new TypeError('Invalid reminder id');
    if (typeof obj.text !== 'string' || obj.text.trim().length < 1 || obj.text.length > 500) throw new TypeError('Invalid reminder text');
    if (typeof obj.dueAt !== 'string' || !Number.isFinite(Date.parse(obj.dueAt))) throw new TypeError('Invalid reminder dueAt');
    if (typeof obj.createdAt !== 'string' || !Number.isFinite(Date.parse(obj.createdAt))) throw new TypeError('Invalid reminder createdAt');
    const repeat = obj.repeat === 'daily' || obj.repeat === 'weekdays' || obj.repeat === 'none' ? obj.repeat : 'none';
    return { id: obj.id, text: obj.text, dueAt: obj.dueAt, createdAt: obj.createdAt, repeat };
  });
}

export function nextReminderDelay(dueAt: string, now = Date.now()): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Date.parse(dueAt) - now));
}

export function nextRepeatDueAt(dueAt: string, repeat: ReminderRepeat, now = Date.now()): string {
  if (repeat === 'none') return dueAt;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return new Date(now + 60_000).toISOString();
  for (let guard = 0; guard < 800; guard += 1) {
    due.setDate(due.getDate() + 1);
    if (due.getTime() <= now) continue;
    if (repeat === 'weekdays') {
      const day = due.getDay();
      if (day === 0 || day === 6) continue;
    }
    break;
  }
  return due.toISOString();
}
