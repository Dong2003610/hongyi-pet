// AI 聊天的本地/免费上下文技能：农历、节假日调休、今日提醒、电脑状态、每日一句。
import os from 'node:os';
import { powerMonitor } from 'electron';
import type { Reminder } from '../shared/contracts';
import { localDateKey } from './data-validation';

const REQUEST_TIMEOUT_MS = 6_000;

interface LunarLike {
  getYearInChinese(): string;
  getMonthInChinese(): string;
  getDayInChinese(): string;
  getYearShengXiao(): string;
  getYearInGanZhi(): string;
  getFestivals(): string[];
  getJieQi(): string;
}
interface SolarLike {
  getFestivals(): string[];
}
const lunarLib = require('lunar-javascript') as {
  Lunar: { fromDate(date: Date): LunarLike };
  Solar: { fromDate(date: Date): SolarLike };
};

let holidayCache: { dateKey: string; lines: string[] } | undefined;
let hitokotoCache: { dateKey: string; line: string } | undefined;

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── 农历 / 生肖 / 节日（纯本地计算） ──
function getLunarLine(): string | undefined {
  try {
    const lunar = lunarLib.Lunar.fromDate(new Date());
    const solar = lunarLib.Solar.fromDate(new Date());
    const festivals = [...new Set([...(solar.getFestivals() ?? []), ...(lunar.getFestivals() ?? [])])];
    const jieqi = lunar.getJieQi();
    let line = `传统历法：农历${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}，${lunar.getYearShengXiao()}年（${lunar.getYearInGanZhi()}年）`;
    if (festivals.length) line += `，今天是${festivals.join('、')}`;
    if (jieqi) line += `，今日${jieqi}`;
    return line;
  } catch {
    return undefined;
  }
}

// ── 节假日 / 调休（timor 免费接口，按天缓存） ──
interface HolidayResponse {
  holiday: { holiday: boolean; name: string } | null;
  type?: { type: number; name: string };
}

function describeHoliday(resp: HolidayResponse): string {
  if (resp.holiday) {
    return resp.holiday.holiday ? `${resp.holiday.name}假期` : `${resp.holiday.name}调休补班日，要上班`;
  }
  if (resp.type?.type === 1) return '周末';
  if (resp.type?.type === 3) return '调休补班日，要上班';
  return '工作日';
}

async function getHolidayLines(): Promise<string[]> {
  const todayKey = localDateKey();
  if (holidayCache?.dateKey === todayKey) return holidayCache.lines;
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const [today, next] = await Promise.all([
      getJson<HolidayResponse>(`https://timor.tech/api/holiday/info/${todayKey}`),
      getJson<HolidayResponse>(`https://timor.tech/api/holiday/info/${localDateKey(tomorrow)}`),
    ]);
    const lines = [`今天是${describeHoliday(today)}`, `明天是${describeHoliday(next)}`];
    holidayCache = { dateKey: todayKey, lines };
    return lines;
  } catch {
    return [];
  }
}

// ── 今日提醒（已有数据，纯本地） ──
function getReminderLines(reminders: Reminder[]): string[] {
  const todayKey = localDateKey();
  const now = new Date();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  const todayReminders = reminders
    .filter((r) => {
      if (r.repeat === 'daily') return true;
      if (r.repeat === 'weekdays') return weekday;
      return localDateKey(new Date(r.dueAt)) === todayKey;
    })
    .filter((r) => r.repeat !== 'none' || new Date(r.dueAt).getTime() >= Date.now() - 60_000)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    .slice(0, 5)
    .map((r) => {
      const due = new Date(r.dueAt);
      return `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')} ${r.text}`;
    });
  if (!todayReminders.length) return [];
  return [`用户今天的待办提醒：${todayReminders.join('；')}。用户问日程/待办时以此为准。`];
}

// ── 电脑状态（纯本地） ──
function getComputerLine(): string | undefined {
  try {
    const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
    const parts = [`内存占用 ${memUsedPct}%`];
    try {
      parts.push(powerMonitor.isOnBatteryPower() ? '使用电池供电' : '已接通电源');
    } catch {
      // 个别环境不可用，跳过
    }
    return `电脑状态：${parts.join('，')}。用户问电脑情况时以此为准。`;
  } catch {
    return undefined;
  }
}

// ── 每日一句（hitokoto 免费接口，按天缓存） ──
interface HitokotoResponse {
  hitokoto: string;
  from_who?: string;
}

async function getHitokotoLine(): Promise<string[]> {
  const todayKey = localDateKey();
  if (hitokotoCache?.dateKey === todayKey) return [hitokotoCache.line];
  try {
    const data = await getJson<HitokotoResponse>('https://v1.hitokoto.cn/?c=i&c=k&c=a&max_len=40');
    if (!data.hitokoto) return [];
    const author = data.from_who ? ` —— ${data.from_who}` : '';
    const line = `今日一句：「${data.hitokoto}」${author}。闲聊或鼓励用户时可以自然引用。`;
    hitokotoCache = { dateKey: todayKey, line };
    return [line];
  } catch {
    return [];
  }
}

// 汇总所有技能上下文行；任何一项失败都不影响其余项。
export async function buildContextLines(reminders: Reminder[]): Promise<string[]> {
  const lines: string[] = [];
  const lunarLine = getLunarLine();
  if (lunarLine) lines.push(lunarLine);
  const computerLine = getComputerLine();
  if (computerLine) lines.push(computerLine);
  lines.push(...getReminderLines(reminders));
  const [holidayLines, hitokotoLines] = await Promise.all([getHolidayLines(), getHitokotoLine()]);
  lines.push(...holidayLines, ...hitokotoLines);
  return lines;
}
