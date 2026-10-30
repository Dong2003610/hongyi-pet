import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ChatMessage, NewsPreferences, NewsStatus } from '../shared/contracts';

export type NewsCategory = 'finance' | 'tech' | 'ai' | 'policy';
export interface NewsItem {
  id: string; title: string; url: string; excerpt: string; publishedAt: string;
  source: string; official: boolean; categories: NewsCategory[];
}
interface Feed { name: string; url: string; hosts: string[]; category: NewsCategory; official?: boolean }
export const NEWS_FEEDS: Feed[] = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', hosts: ['www.ithome.com'], category: 'tech' },
  { name: 'Solidot', url: 'https://www.solidot.org/index.rss', hosts: ['www.solidot.org'], category: 'tech' },
  { name: 'OpenAI 官方', url: 'https://openai.com/news/rss.xml', hosts: ['openai.com'], category: 'ai', official: true },
  { name: 'CNBC 财经', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', hosts: ['www.cnbc.com'], category: 'finance' },
  { name: '美联储官方', url: 'https://www.federalreserve.gov/feeds/press_all.xml', hosts: ['www.federalreserve.gov'], category: 'policy', official: true },
  { name: '欧洲央行官方', url: 'https://www.ecb.europa.eu/rss/press.html', hosts: ['www.ecb.europa.eu'], category: 'policy', official: true },
  { name: '联合国官方', url: 'https://www.un.org/sg/en/rss.xml', hosts: ['www.un.org'], category: 'policy', official: true },
];
export const NEWS_LABELS: Record<NewsCategory, string> = { finance: '财经', tech: '科技', ai: 'AI', policy: '国际政策' };
const defaults: NewsPreferences = { enabled: false, time: '09:00' };
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const day = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const stamp = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
const array = (v: any): any[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
function value(v: any): string { return typeof v === 'string' || typeof v === 'number' ? String(v) : typeof v?.['#text'] === 'string' ? v['#text'] : ''; }
export function plainText(v: unknown, limit = 700): string {
  const text = typeof v === 'string' ? v : '';
  return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[s]!)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function newsUrl(raw: string): string | undefined {
  try {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    const url = new URL(raw.replace(/&amp;/g, '&'));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (!NEWS_FEEDS.some(f => f.hosts.includes(url.hostname))) return;
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid)$/i.test(k)) url.searchParams.delete(k);
    return url.href;
  } catch { return; }
}
export function parseFeed(xml: string, feed: Feed, now = Date.now()): NewsItem[] {
  if (Buffer.byteLength(xml) > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('不支持此订阅格式');
  if (XMLValidator.validate(xml) !== true) throw new Error('订阅格式损坏');
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, parseTagValue: false }).parse(xml);
  if ((!doc.rss || !Object.hasOwn(doc.rss, 'channel')) && (!doc.feed || !Object.hasOwn(doc, 'feed'))) throw new Error('该地址未返回 RSS/Atom');
  const entries = array(doc.rss?.channel?.item ?? doc.feed?.entry);
  const items: NewsItem[] = [];
  for (const entry of entries.slice(0, 500)) {
    const rawLink = typeof entry.link === 'string' ? entry.link : value(array(entry.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href']);
    const url = newsUrl(rawLink), title = plainText(value(entry.title), 350);
    if (!url || !feed.hosts.includes(new URL(url).hostname) || !title) continue;
    const ms = Date.parse(value(entry.pubDate ?? entry.published ?? entry.updated ?? entry['dc:date']));
    // Missing, future and old dates never masquerade as today's news.
    if (!Number.isFinite(ms) || ms > now + 10 * 60000 || ms < now - 7 * 86400000) continue;
    const excerpt = plainText(value(entry.description ?? entry.summary ?? entry['content:encoded'] ?? entry.content));
    const categories: NewsCategory[] = [feed.category];
    if (feed.category === 'tech' && /\bAI\b|人工智能|大模型|机器学习|OpenAI|Anthropic|ChatGPT|Gemini|智谱|DeepSeek/i.test(`${title} ${excerpt.slice(0, 180)}`)) categories.unshift('ai');
    items.push({ id: hash(url), title, url, excerpt, publishedAt: new Date(ms).toISOString(), source: feed.name, official: Boolean(feed.official), categories });
  }
  return items;
}
export function deduplicate(items: NewsItem[]): NewsItem[] {
  const urls = new Set<string>(), titles = new Set<string>();
  return [...items].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || Number(b.official) - Number(a.official)).filter(item => {
    const key = item.title.toLowerCase().replace(/[\p{P}\p{Z}\p{S}]/gu, '');
    if (urls.has(item.url) || titles.has(key)) return false;
    urls.add(item.url); titles.add(key); return true;
  });
}
export async function fetchFeed(feed: Feed): Promise<string> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    // Feed destinations are fixed; redirects cannot turn a feed into arbitrary
    // internal-network access. Article links are never fetched automatically.
    const response = await fetch(feed.url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/rss+xml, application/atom+xml, text/xml' } });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 2_000_000) throw new Error('订阅响应过大'); chunks.push(value);
    } } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); }
}

interface NewsState { version: 1; preferences: NewsPreferences; fetchedAt: number; items: NewsItem[]; seen: string[]; pushedDay?: string; failures: string[] }
interface Options {
  load: () => Promise<unknown>; save: (state: unknown) => Promise<void>;
  fetch?: (feed: Feed) => Promise<string>; now?: () => number;
  explain?: (item: NewsItem, question: string) => Promise<string | undefined>;
  summarize?: (items: NewsItem[]) => Promise<string | undefined>;
}
export class NewsService {
  private state: NewsState = { version: 1, preferences: { ...defaults }, fetchedAt: 0, items: [], seen: [], failures: [] };
  private refreshPromise?: Promise<void>;
  private lastAttempt = -Infinity;
  private selected: NewsItem[] = [];
  private activeItem?: NewsItem;
  private selectedAt = 0;
  private actions = new Map<string, { item: NewsItem; at: number }>();
  private deliveryBusy = false;
  private preferenceVersion = 0;
  private persistence: Promise<void> = Promise.resolve();
  private configuration: Promise<unknown> = Promise.resolve();
  private cacheSaveFailed = false;
  private readonly now: () => number;
  constructor(private options: Options) { this.now = options.now ?? Date.now; }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const result = this.persistence.then(() => this.options.save(snapshot)); this.persistence = result.catch(() => {}); return result;
  }
  async restore(): Promise<void> {
    try {
      const raw = await this.options.load() as Partial<NewsState> | null;
      if (!raw || raw.version !== 1) return;
      const prefs = raw.preferences;
      if (prefs && typeof prefs.enabled === 'boolean' && /^([01]\d|2[0-3]):[0-5]\d$/.test(prefs.time)) this.state.preferences = { ...prefs };
      this.state.items = deduplicate((Array.isArray(raw.items) ? raw.items : []).filter(item => item && typeof item.title === 'string' && typeof item.excerpt === 'string' && typeof item.source === 'string' && newsUrl(item.url) === item.url && item.id === hash(item.url) && Number.isFinite(Date.parse(item.publishedAt)) && Date.parse(item.publishedAt) <= this.now() + 600000 && this.now() - Date.parse(item.publishedAt) <= 7 * 86400000 && Array.isArray(item.categories) && item.categories.every(c => Object.hasOwn(NEWS_LABELS, c))).slice(0, 300));
      this.state.fetchedAt = typeof raw.fetchedAt === 'number' && raw.fetchedAt <= this.now() ? raw.fetchedAt : 0;
      this.state.seen = Array.isArray(raw.seen) ? raw.seen.filter(s => typeof s === 'string').slice(-1000) : [];
      this.state.pushedDay = typeof raw.pushedDay === 'string' ? raw.pushedDay : undefined;
      this.state.failures = Array.isArray(raw.failures) ? raw.failures.filter(s => typeof s === 'string').slice(0, 20) : [];
    } catch { /* A bad cache never prevents startup; new retrieval can recover. */ }
  }
  status(): NewsStatus { return { preferences: { ...this.state.preferences }, fetchedAt: this.state.fetchedAt ? new Date(this.state.fetchedAt).toISOString() : undefined,
    failures: [...this.state.failures], sources: NEWS_FEEDS.map(f => ({ name: f.name, official: Boolean(f.official) })) }; }
  async configure(input: unknown): Promise<NewsPreferences> {
    if (!input || typeof input !== 'object') throw new Error('新闻设置无效');
    const obj = input as Record<string, unknown>;
    if (Object.keys(obj).some(k => !['enabled', 'time'].includes(k)) || typeof obj.enabled !== 'boolean' || typeof obj.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(obj.time)) throw new Error('新闻时间请使用 HH:mm');
    const next = { enabled: obj.enabled, time: obj.time };
    const operation = this.configuration.then(async () => {
      const previous = this.state.preferences; this.state.preferences = next; this.preferenceVersion++;
      try { await this.persist(); } catch { this.state.preferences = previous; throw new Error('新闻设置保存失败，原设置已保留'); }
      return { ...this.state.preferences };
    });
    this.configuration = operation.catch(() => {});
    return operation;
  }
  reset(): void { this.forgetSelection(); this.actions.clear(); }
  forgetSelection(): void { this.selected = []; this.activeItem = undefined; this.selectedAt = 0; }
  private async refresh(force = false): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const now = this.now();
    if (now - this.lastAttempt < 60000 || (!force && this.state.fetchedAt && now - this.state.fetchedAt < 15 * 60000)) return;
    this.lastAttempt = now;
    this.refreshPromise = (async () => {
      const results = await Promise.allSettled(NEWS_FEEDS.map(async feed => parseFeed(await (this.options.fetch ?? fetchFeed)(feed), feed, this.now())));
      const failures: string[] = [], fresh: NewsItem[] = []; let successful = 0;
      for (const [i, result] of results.entries()) {
        if (result.status === 'fulfilled') { successful++; fresh.push(...result.value); }
        else failures.push(NEWS_FEEDS[i]!.name);
      }
      this.state.failures = failures;
      const retained = this.state.items.filter(item => failures.includes(item.source) && this.now() - Date.parse(item.publishedAt) <= 7 * 86400000);
      if (successful) { this.state.items = deduplicate([...fresh, ...retained]).slice(0, 300); this.state.fetchedAt = this.now(); }
      try { await this.persist(); this.cacheSaveFailed = false; } catch { this.cacheSaveFailed = true; }
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  private pick(category?: NewsCategory, unseen = false): NewsItem[] {
    const items = this.state.items.filter(i => this.now() - Date.parse(i.publishedAt) <= 7 * 86400000 && (!category || i.categories.includes(category)) && (!unseen || !this.state.seen.includes(i.id)));
    if (category) return items.slice(0, 8);
    const result: NewsItem[] = [];
    for (const c of ['finance', 'tech', 'ai', 'policy'] as NewsCategory[]) {
      for (const item of items.filter(i => i.categories.includes(c) && !result.some(r => r.id === i.id)).slice(0, 2)) result.push(item);
    }
    return result;
  }
  private select(items: NewsItem[]): void {
    this.selected = items; this.activeItem = undefined; this.selectedAt = this.now(); this.actions.clear();
    for (const item of items) this.actions.set(`news:${item.id}`, { item, at: this.now() });
  }
  private message(items: NewsItem[], heading: string): ChatMessage {
    const unavailable = this.state.failures.length ? `\n暂不可用：${this.state.failures.join('、')}；可用源和缓存结果已保留。` : '';
    return { role: 'assistant', source: 'news', content: `${heading} · 北京时间\n覆盖最近 7 天，优先最新；各条日期以卡片为准。${this.state.fetchedAt ? `\n最近获取：${stamp(new Date(this.state.fetchedAt).toISOString())}` : ''}${unavailable}${this.cacheSaveFailed ? '\n缓存保存失败，本次结果仅在本次运行中保留。' : ''}${items.length ? '\n可说“第二条新闻详细讲讲”，或点击原文。' : '\n当前没有可展示的新闻，请稍后重试。'}`,
      cards: items.map(item => {
        const id = `news:${item.id}`;
        return { kind: 'news', title: item.title, url: item.url, detail: `${item.categories.map(c => NEWS_LABELS[c]).join('/')} · ${item.source}${item.official ? ' · 官方' : ''}\n${stamp(item.publishedAt)} 发布\n${item.excerpt || '订阅源未提供摘要，请查看原文。'}`, actions: [{ id, label: '摘要与解读' }] };
      }) };
  }
  async digest(category?: NewsCategory, force = false): Promise<ChatMessage> {
    try { await this.refresh(force); } catch { /* Still expose usable cache with an explicit warning. */ }
    const items = this.pick(category);
    const result = this.message(items, category ? `${NEWS_LABELS[category]}新闻` : '今日新闻简报');
    await this.addSummary(result, items);
    this.select(items);
    return result;
  }
  private async addSummary(message: ChatMessage, items: NewsItem[]): Promise<void> {
    if (!items.length) return;
    try {
      const summary = await this.options.summarize?.(items);
      message.content += summary ? `\n\nAI 概览（基于订阅摘要，未核验全文）：\n${plainText(summary, 1500)}` : '\n摘要直接来自订阅源；AI 未配置或暂不可用。';
    } catch { message.content += '\nAI 概览暂不可用，原始新闻卡片仍可查看。'; }
  }
  private async explain(item: NewsItem, question: string): Promise<ChatMessage> {
    let detail: string | undefined;
    try { detail = await this.options.explain?.(item, question); } catch { /* Original source stays available. */ }
    return { role: 'assistant', source: 'news', content: detail ? `AI 根据订阅摘要整理，尚未核验全文；分析不等于已证实事实。\n${plainText(detail, 1800)}` : 'AI 未配置或暂不可用，以下保留订阅源摘要；可打开原文查看。',
      cards: [{ kind: 'news', title: item.title, url: item.url, detail: `${item.source} · ${stamp(item.publishedAt)} 发布\n${item.excerpt || '此源未提供摘要。'}` }] };
  }
  async act(id: string): Promise<ChatMessage> {
    const selected = this.actions.get(id);
    if (!selected || this.now() - selected.at > 30 * 60000) return { role: 'assistant', source: 'news', content: '这张新闻卡片已过期，请重新查询新闻。' };
    if (!this.selected.some(item => item.id === selected.item.id)) this.select([selected.item]);
    this.activeItem = selected.item; this.selectedAt = this.now();
    return this.explain(selected.item, '请用中文概括消息，并将可能影响与已知事实分开。');
  }
  async turn(raw: string): Promise<ChatMessage | undefined> {
    const text = raw.trim();
    if (/新闻/.test(text) && /(?:开启|打开|订阅|关闭|取消|停止).*(?:推送|简报)|(?:推送|简报).*(?:开启|关闭|取消)/.test(text)) {
      const enabled = !/关闭|取消|停止|不要/.test(text);
      const match = /(\d{1,2})[:：点时](\d{2})?/.exec(text);
      const time = match ? `${match[1]!.padStart(2, '0')}:${match[2] ?? '00'}` : this.state.preferences.time;
      try { await this.configure({ enabled, time }); return { role: 'assistant', source: 'news', content: enabled ? `已开启每日新闻推送，北京时间 ${time}。专注和免打扰期间会延后；桌宠需保持运行。` : '已关闭每日新闻推送，仍可随时主动查询。' }; }
      catch (e) { return { role: 'assistant', source: 'news', content: e instanceof Error ? e.message : '设置未能保存。' }; }
    }
    const number = /第\s*([一二三四五六七八1-8])\s*(?:条|则)(?:新闻)?/.exec(text);
    const followup = /详细|展开|解读|影响|解释|讲讲|分析|总结/.test(text);
    if (followup && !/任务|待办|周计划/.test(text) && (number && (this.selected.length || /新闻/.test(text)) || /这条新闻|这则新闻|刚才的新闻/.test(text) || this.selected.length && /这(?:条|则|对)|它|该消息/.test(text))) {
      if (this.now() - this.selectedAt > 30 * 60000 || !this.selected.length) return { role: 'assistant', source: 'news', content: '请先查询新闻，我会按刚展示的新闻序号解释。' };
      const n = number ? Number(number[1]) || '一二三四五六七八'.indexOf(number[1]!) + 1 : 1;
      const item = number ? this.selected[n - 1] : this.activeItem ?? this.selected[0];
      if (!item) return { role: 'assistant', source: 'news', content: '刚才的新闻列表没有这一条，请按显示的序号选择。' };
      // Keep the displayed numbering stable; a pronoun can refer to this item
      // without renumbering the last digest.
      this.activeItem = item; this.selectedAt = this.now();
      return this.explain(item, text);
    }
    if (!/新闻|资讯|头条|AI快讯/i.test(text) || /任务|待办|专注|提醒我|(?:新增|添加|创建|完成|删除|修改).*(?:任务|待办)/.test(text)) return;
    const category: NewsCategory | undefined = /AI|人工智能|大模型/i.test(text) ? 'ai' : /财经|金融|股市|经济/.test(text) ? 'finance' : /国际|政策|外交/.test(text) ? 'policy' : /科技|数码/.test(text) ? 'tech' : undefined;
    return this.digest(category, /刷新|重新获取|更新/.test(text));
  }
  async tick(blocked: boolean, deliver: (reply: ChatMessage, activate: () => boolean) => Promise<void>): Promise<void> {
    if (blocked || this.deliveryBusy || !this.state.preferences.enabled) return;
    const now = this.now(), today = day(now), localTime = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
    if (this.state.pushedDay === today || localTime < this.state.preferences.time) return;
    this.deliveryBusy = true; const revision = this.preferenceVersion;
    try {
      await this.refresh();
      if (!this.state.preferences.enabled || revision !== this.preferenceVersion || day(this.now()) !== today) return;
      const items = this.pick(undefined, true); if (!items.length) return;
      const message = this.message(items, '每日新闻推送');
      await this.addSummary(message, items);
      if (!this.state.preferences.enabled || revision !== this.preferenceVersion || day(this.now()) !== today) return;
      await deliver(message, () => {
        if (!this.state.preferences.enabled || revision !== this.preferenceVersion || day(this.now()) !== today) return false;
        this.select(items); return true;
      });
      this.state.seen = [...new Set([...this.state.seen, ...items.map(i => i.id)])].slice(-1000); this.state.pushedDay = today;
      // A delivered notification cannot be undone. Keep its in-memory receipt
      // even if storage fails, so the next timer does not notify every minute.
      try { await this.persist(); } catch { this.cacheSaveFailed = true; }
    } finally { this.deliveryBusy = false; }
  }
}
