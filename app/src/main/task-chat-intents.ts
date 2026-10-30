import type { TaskCompanionPreferences } from '../shared/contracts';

export type CompanionIntent =
  | { type: 'focus'; action: 'start'; target: string; minutes: number }
  | { type: 'focus'; action: 'pause' | 'resume' | 'stop' | 'retry' | 'status' }
  | { type: 'briefing'; kind: 'morning' | 'evening' }
  | { type: 'plan'; goal: string }
  | { type: 'rollover' }
  | { type: 'suggest' }
  | { type: 'configure'; patch: Partial<TaskCompanionPreferences> };

export function actionable(text: string): boolean {
  return !/(?:不要|不用|不想|不需要|先不|暂不|不启动|不开始|不开启|不执行|不添加|不保存|不提醒|如果|假如|要是|怎么(?!样)|如何|怎样|能不能识别|测试指令)/.test(text)
    && !/(?:^|[，,\s]|请|帮我|给我|先|就)别(?:再)?/.test(text)
    && !/[“「"].*(?:专注|计时|提醒|完成|添加|拆解).*[”」"]/.test(text)
    && !/(?:了吗|了么|是否|有没有|会不会)/.test(text);
}
// Polite requests remain commands. Information questions and reported speech
// still cannot authorize a write, even when a model proposes one.
export function requestText(text: string): string {
  return text.trim().replace(/^(?:请问)?(?:能不能|可不可以|能否|可以|能)(?:请)?(?=帮我|给我|麻烦你)/, '')
    .replace(/(?:可以吗|可以么|好吗|好么|行吗|行么|吗|么|吧)[。！!？?]*$/, '').replace(/[。！!？?]+$/, '').trim();
}
export const actionQuestion = (text: string): boolean => /是什么|什么意思|有啥用|有什么用|为什么|为啥|是不是|完成了吗|做完了吗|写完了吗/.test(text)
  || (/[？?]|(?:吗|么)[。！!]*$/.test(text) && !/^(?:请问)?(?:能不能|可不可以|能否|可以|能)?(?:请)?(?:帮我|给我|麻烦你)/.test(text)
    && !/(?:可以吗|好吗|行吗)[？?。！!]*$/.test(text));
export const companionCandidate = (text: string) => /专注|番茄钟|计时|简报|复盘|总结.*今天|今天.*总结|拆解|拆分|拆成|遗留|没做完.*明天|未完成.*明天|到点提醒|免打扰|先做这个|先做什么|挑一件|任务太多/.test(text);
export function chineseNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  text = text.replace(/两/g, '二');
  if (text === '半') return .5;
  const hundred = text.split('百');
  if (hundred.length === 2) return chineseNumber(hundred[0]!) * 100 + (hundred[1] ? chineseNumber(hundred[1]!.replace(/^零/, '')) : 0);
  const tens = text.split('十');
  if (tens.length === 2) return (tens[0] ? digits.indexOf(tens[0]) : 1) * 10 + (tens[1] ? digits.indexOf(tens[1]) : 0);
  return text.length === 1 ? digits.indexOf(text) : NaN;
}
const DURATION = /([\d零一二两三四五六七八九十百半]+)\s*(分钟|分|小时|个小时)/;
export function focusMinutes(text: string): number | undefined {
  const found = DURATION.exec(text);
  return found ? chineseNumber(found[1]!) * (/小时/.test(found[2]!) ? 60 : 1) : undefined;
}
export function reminderClock(text: string): string | undefined {
  const clock = /([\d零一二两三四五六七八九十]+)(?:[:：点时])(?:([\d零一二两三四五六七八九十]+)(?:分)?|(半))?/.exec(text);
  if (!clock) return;
  let hour = chineseNumber(clock[1]!);
  const minute = clock[3] ? 30 : clock[2] ? chineseNumber(clock[2]) : 0;
  if (/下午|晚上|傍晚/.test(text) && hour >= 1 && hour < 12) hour += 12;
  if (/中午/.test(text) && hour < 11) hour += 12;
  if (/凌晨|上午|早上/.test(text) && hour === 12) hour = 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return;
  // Bare 3点 is ambiguous (03:00 vs 15:00). Ask instead of guessing.
  if (!/[:：]|凌晨|上午|早上|中午|下午|晚上|傍晚/.test(text) && hour > 0 && hour < 12) return;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
export function taskReminderTime(text: string, date: string, now: Date): string | undefined {
  if (/每天|每周|每月|重复/.test(text)) return;
  const relative = /([\d零一二两三四五六七八九十百半]+)\s*(分钟|分|小时|个小时)后/.exec(text);
  if (relative) {
    const minutes = chineseNumber(relative[1]!) * (/小时/.test(relative[2]!) ? 60 : 1);
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 10080) return new Date(now.getTime() + minutes * 60_000).toISOString();
    return;
  }
  const clock = reminderClock(text); if (!clock) return;
  const timestamp = new Date(`${date}T${clock}:00+08:00`);
  return Number.isFinite(timestamp.getTime()) && timestamp.getTime() > now.getTime() ? timestamp.toISOString() : undefined;
}
const clean = (text: string) => text.trim().replace(/[，,。！!？?]+$/, '').trim();
export function localCompanionIntent(text: string): CompanionIntent | undefined {
  if (!actionable(text)) return;
  const input = requestText(text).replace(/^(?:请)?(?:帮我|给我|麻烦你)?\s*/, '');
  if (actionQuestion(text)) {
    if (/先做什么|挑一件/.test(input)) return { type: 'suggest' };
    if (/(?:专注|计时|番茄钟).*(?:还剩|多久|状态|进度|怎么样)/.test(input)) return { type: 'focus', action: 'status' };
    if (/简报|复盘|总结.*今天|今天.*(?:总结|完成得怎么样)/.test(input) && !/开启|关闭|打开|关掉|设置|每天/.test(input)) return { type: 'briefing', kind: /复盘|总结|完成得/.test(input) ? 'evening' : 'morning' };
    return;
  }
  if (/先做什么|挑一件|任务太多|不知道先做/.test(input)) return { type: 'suggest' };
  if (/^(?:先)?暂停(?:一下|下|刚才的|当前的|任务)?(?:专注|计时|番茄钟)?(?:计时)?(?:一下|吧)?$/.test(input)) return { type: 'focus', action: 'pause' };
  if (/^继续(?:一下|下|刚才的|当前的|任务)?(?:专注|计时|番茄钟)?(?:计时)?(?:吧)?$/.test(input)) return { type: 'focus', action: 'resume' };
  if (/^(?:结束|停止)(?:一下|刚才的|当前的|本轮|任务)?(?:专注|计时|番茄钟)(?:计时)?(?:吧)?$/.test(input)) return { type: 'focus', action: 'stop' };
  if (/重试.*(?:同步|专注)|(?:同步|专注).*重试/.test(input)) return { type: 'focus', action: 'retry' };
  if (/(?:专注|计时|番茄钟).*(?:还剩|多久|状态|进度|怎么样)|(?:还剩|查看|看看).*(?:专注|计时|番茄钟)/.test(input)) return { type: 'focus', action: 'status' };
  const config = /开启|打开|启用|关闭|关掉|停用/.exec(input);
  const setting = /清单到点提醒|任务到点提醒|到点提醒|每日简报|晚间复盘|免打扰/.exec(input);
  if (config && setting) {
    const key = /提醒/.test(setting[0]) ? 'reminders' : setting[0] === '每日简报' ? 'morning' : setting[0] === '晚间复盘' ? 'evening' : 'quiet';
    return { type: 'configure', patch: { [key]: /开启|打开|启用/.test(config[0]) } };
  }
  if (/每天/.test(input) && /简报|复盘/.test(input)) {
    const time = reminderClock(input); if (!time) return;
    return /复盘/.test(input) ? { type: 'configure', patch: { evening: true, eveningTime: time } } : { type: 'configure', patch: { morning: true, morningTime: time } };
  }
  if (/免打扰/.test(input)) {
    const times = input.match(/(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d(?!\d)/g);
    if (times?.length === 2) return { type: 'configure', patch: { quiet: true, quietStart: times[0], quietEnd: times[1] } };
    return;
  }
  if (/简报|复盘|(?:总结|汇总).*(?:今天|今日)|(?:今天|今日).*(?:总结|完成得怎么样|做得怎么样)/.test(input)) return { type: 'briefing', kind: /复盘|总结|完成得|做得/.test(input) ? 'evening' : 'morning' };
  if (/遗留|(?:没做完|未完成|没完成).*(?:明天|接续)/.test(input) && /安排|接续|明天|挪|放|推迟/.test(input)) return { type: 'rollover' };
  const plan = /^(?:把|将)?(?:本周|这周|下周)?(?:的)?(?:周目标|周计划|目标)?[：:\s]*(.+?)(?:拆解|拆分|拆成|分解|分成)(?:成|为)?(?:每天|每日|小任务|步骤|任务|计划|要做的|的|一下|吧)*$/.exec(input);
  const planPrefix = /^(?:拆解|拆分|分解)(?:一下)?(?:本周|这周|下周)?(?:的)?(?:周目标|周计划|目标)?[：:\s]*(.+)$/.exec(input);
  const goal = clean(plan?.[1] ?? planPrefix?.[1] ?? '');
  if (goal && !/^(?:本周|这周|下周)?(?:的)?(?:周目标|周计划|目标)$/.test(goal)) return { type: 'plan', goal };
  if (/专注|番茄钟|计时|先做这个/.test(input) && !/[？?]|(?:吗|么)$/.test(input)) {
    let target = input.replace(DURATION, '').replace(/^(?:开始|开启|启动|开个|开一个|我要|我想)?(?:任务)?(?:专注(?:计时)?|番茄钟|计时)(?:做)?[：:\s]*/, '')
      .replace(/^(?:给|为|把|将|对)/, '').replace(/(?:开个|开一个|开始|开启|启动)?(?:任务)?(?:专注|番茄钟|计时)(?:计时)?(?:吧|一下)?$/, '')
      .replace(/(?:这个任务|这项任务|任务)$/, '').replace(/[，,：:]/g, '').trim();
    target = target.replace(/^(?:任务|待办)[：:\s]*/, '').replace(/^先做/, '');
    return { type: 'focus', action: 'start', target, minutes: focusMinutes(input) ?? 25 };
  }
  return;
}

// AI is a parser, not an executor. IDs, arbitrary settings and inferred task
// names are forbidden. Only a target literally present in this message is used.
export function validateCompanionIntent(raw: unknown, text: string): CompanionIntent | undefined {
  if (!actionable(text) || actionQuestion(text) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  if (obj.type === 'focus' && /专注|番茄钟|计时/.test(text)) {
    if (obj.action !== 'start') {
      const allowed = ({ pause: /暂停|停一下/, resume: /继续|恢复/, stop: /结束|停止/, retry: /重试|同步/, status: /状态|还剩|多久|进度/ }) as Record<string, RegExp>;
      if (typeof obj.action === 'string' && allowed[obj.action]?.test(text)) return { type: 'focus', action: obj.action as 'pause' | 'resume' | 'stop' | 'retry' | 'status' };
    } else if (typeof obj.target === 'string' && obj.target.trim() && text.includes(obj.target.trim())) {
      const minutes = focusMinutes(text) ?? 25;
      if (obj.minutes === minutes) return { type: 'focus', action: 'start', target: obj.target.trim(), minutes };
    }
  }
  if (obj.type === 'plan' && /拆解|拆分|拆成|分解|分成/.test(text) && typeof obj.goal === 'string' && obj.goal.trim() && text.includes(obj.goal.trim())) return { type: 'plan', goal: obj.goal.trim() };
  // Other companion actions are deliberately resolved locally: no model may
  // invent a batch write, notification consent, or a configuration toggle.
  return;
}
