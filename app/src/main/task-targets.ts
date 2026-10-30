import type { LinkedTask } from '../shared/contracts';
import { chineseNumber } from './task-chat-intents';

// Keep meaningful symbols (C++, C#, issue-12, a/b) distinct for exact writes.
export const normalizeTaskName = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[\s“”「」『』"'《》]/g, '');

export const quotedTaskTarget = (text: string): string | undefined => /^(?:请)?(?:帮我|给我)?(?:把|将|给)\s*[“「『《"']([^“”「」『』《》"']+)[”」』》"']/.exec(text)?.[1];

// Quoted titles are data, not quoted instructions. Only mask them when there
// is an explicit operation outside the quotes; reported speech stays blocked.
export function taskInstructionText(text: string): string {
  text = text.trim();
  if (/^(?:请)?(?:帮我|给我)?(?:把|将|给)/.test(text)) {
    return text.replace(/[“「『《"']([^“”「」『』《》"']+)[”」』》"'](?=\s*(?:(?:这个|这项|这条)?(?:任务|待办))?(?:的)?\s*(?:优先级|提醒|改名|重命名|名称|标记|勾选|设|改|转|调))/, '指定事项');
  }
  return text;
}

export function cleanTaskTarget(text: string): string {
  let result = text.trim().replace(/^(?:今天|今日|明天|后天|昨天|本周|这周|下周|\d{4}-\d{1,2}-\d{1,2})(?:的)?/, '').trim();
  result = result.replace(/^(?:周计划|周目标|任务|待办)[：:\s]*/, '');
  const quoted = /^[“「『《"']([^“”「」『』《》"']+)[”」』》"']\s*(?:(?:这个|这项|这条)?(?:任务|待办))?$/.exec(result);
  if (quoted) return quoted[1]!.trim();
  return result.replace(/(?:这个任务|这项任务|这条任务|这个待办|的任务|的待办)$/, '').trim();
}

// Accept Chinese/Arabic numerals and optional task suffixes, but never extract
// a number from an actual title such as “第2季度报告”. Returns a one-based index.
export function taskOrdinal(text: string, bare = false): number | undefined {
  const input = text.normalize('NFKC').trim().replace(/[。！!]+$/, '').replace(/^(?:选择|选)\s*/, '');
  const match = /^(第)?\s*([0-9零〇一二两三四五六七八九十百]+)\s*((?:个|项|条)(?:的)?(?:任务|待办|周计划|周目标)?|任务|待办|周计划|周目标)?$/.exec(input);
  if (!match || (!bare && !match[1] && !match[3])) return;
  const number = chineseNumber(match[2]!.replace(/〇/g, '零'));
  return Number.isSafeInteger(number) && number >= 1 && number <= 99 ? number : undefined;
}

function canonical(text: string): string {
  return normalizeTaskName(cleanTaskTarget(text)).replace(/^(?:那个|这个|那项|这项|关于|有关|把|将)/, '')
    .replace(/的|一下|那个|这个/g, '').replace(/(?:这个|这项|这条)?(?:任务|待办)$/, '')
    .replace(/回归测试|回归验证/g, '回归').replace(/分派/g, '分配').replace(/上交|递交/g, '提交')
    .replace(/修复|解决/g, '处理').replace(/(?:完成|做完|弄完|搞定|完)$/, '');
}
const grams = (text: string) => { const chars = Array.from(text); return new Set(chars.slice(0, -1).map((char, index) => char + chars[index + 1])); };
const intersection = (a: Set<string>, b: Set<string>) => [...a].filter((char) => b.has(char)).length;

// Bounded edit distance: a typo can propose a candidate, never execute it.
function near(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit || Math.max(a.length, b.length) > 96) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[b.length]! <= limit;
}

export function rankTaskTargets(items: LinkedTask[], target: string): { exact: boolean; items: LinkedTask[] } {
  const needle = normalizeTaskName(cleanTaskTarget(target));
  if (!needle) return { exact: false, items: [] };
  const exact = items.filter((item) => normalizeTaskName(item.name) === needle);
  if (exact.length) return { exact: true, items: exact };
  const query = canonical(target);
  if (query.length < 2 || /^(?:任务|待办|事项|东西)$/.test(query)) return { exact: false, items: [] };
  const chars = new Set(query); const pairs = grams(query);
  const ranked = items.map((item, index) => {
    const name = canonical(item.name); let score = 0;
    if (name === query) score = .98;
    else if (name.includes(query)) score = .92 + .03 * query.length / name.length;
    else if (query.includes(name) && name.length >= 4 && name.length / query.length >= .55) score = .88;
    else {
      const other = new Set(name); const common = intersection(chars, other);
      const overlap = common / Math.max(chars.size, other.size);
      const ratio = Math.min(query.length, name.length) / Math.max(query.length, name.length);
      const otherPairs = grams(name); const commonPairs = intersection(pairs, otherPairs);
      const dice = 2 * commonPairs / Math.max(1, pairs.size + otherPairs.size);
      if (common >= 3 && ratio >= .45 && dice >= .5 && overlap >= .6) score = .65 + dice * .2;
      if (common >= 4 && ratio >= .6 && overlap >= .9 && commonPairs >= 1) score = Math.max(score, .84);
      if (query.length >= 4 && common >= 2 && near(query, name, query.length >= 8 ? 2 : 1)) score = Math.max(score, .86);
    }
    return { item, score, index };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return { exact: false, items: ranked.map((entry) => entry.item) };
}
