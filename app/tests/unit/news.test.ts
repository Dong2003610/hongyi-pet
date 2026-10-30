import test from 'node:test';
import assert from 'node:assert/strict';
import { NewsService, NEWS_FEEDS, parseFeed, newsUrl, plainText, deduplicate, fetchFeed } from '../../src/main/news';
import { parseChatHistory } from '../../src/main/data-validation';

const NOW = Date.parse('2026-10-30T02:00:00Z'); // 10:00 Beijing
function rss(host: string, now = NOW, count = 3) {
  return `<rss><channel>${Array.from({ length: count }, (_, i) => `<item><title>${host} 新闻 ${i}</title><link>https://${host}/article/${i}?utm_source=test</link><description><![CDATA[<p>来源摘要 ${i}</p>]]></description><pubDate>${new Date(now - i * 60000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
}
function fixture(extra: Partial<ConstructorParameters<typeof NewsService>[0]> = {}) {
  let now = NOW, calls = 0, offline = false, stored: any;
  const service = new NewsService({ load: async () => stored, save: async value => { stored = structuredClone(value); },
    now: () => now, fetch: async feed => { calls++; if (offline) throw new Error('offline'); return rss(feed.hosts[0]!, now); }, ...extra });
  return { service, now: (value: number) => { now = value; }, offline: () => { offline = true; }, calls: () => calls, stored: () => stored };
}

test('RSS sanitizes HTML/entities, classifies AI and canonicalizes links', () => {
  const xml = rss('www.ithome.com').replace('www.ithome.com 新闻 0', 'AI &amp; 大模型').replace('来源摘要 0', '<script>bad()</script>正常摘要');
  const items = parseFeed(xml, NEWS_FEEDS[0]!, NOW);
  assert.equal(items[0]!.title, 'AI & 大模型'); assert.deepEqual(items[0]!.categories, ['ai', 'tech']);
  assert.equal(items[0]!.excerpt, '正常摘要'); assert.equal(items[0]!.url, 'https://www.ithome.com/article/0');
  assert.equal(plainText('<style>x</style><img onerror="x">正文&nbsp; ok'), '正文 ok');
});
test('Atom and empty valid feeds work; invalid roots, DTD and oversized input fail', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>测试</title><link rel="self" href="https://evil.test"/><link rel="alternate" href="https://openai.com/news/test"/><updated>${new Date(NOW).toISOString()}</updated><summary>摘要</summary></entry></feed>`;
  assert.equal(parseFeed(atom, NEWS_FEEDS[2]!, NOW)[0]!.official, true);
  assert.deepEqual(parseFeed('<rss><channel/></rss>', NEWS_FEEDS[0]!, NOW), []);
  for (const xml of ['<html>hello</html>', '<Error>denied</Error>', '<rss>', '<!DOCTYPE rss><rss/>', 'x'.repeat(2_000_001)]) assert.throws(() => parseFeed(xml, NEWS_FEEDS[0]!, NOW));
});
test('invalid dates, old/future articles and off-source links cannot become news', () => {
  const feed = NEWS_FEEDS[0]!;
  for (const value of ['not-a-date', new Date(NOW - 8 * 86400000).toUTCString(), new Date(NOW + 3600000).toUTCString()]) {
    assert.equal(parseFeed(rss(feed.hosts[0]!, NOW, 1).replace(new Date(NOW).toUTCString(), value), feed, NOW).length, 0);
  }
  assert.equal(parseFeed(rss('openai.com', NOW, 1), feed, NOW).length, 0);
  for (const url of ['file:///a', 'javascript:alert(1)', 'https://localhost/x', 'https://www.ithome.com.evil.test', 'https://a@www.ithome.com', 'https://www.ithome.com:8443', 'http://openai.com/x']) assert.equal(newsUrl(url), undefined);
  assert.equal(newsUrl('https://openai.com/news/x?a=1&amp;b=2&utm_source=x#fragment'), 'https://openai.com/news/x?a=1&b=2');
});
test('deduplication keeps newest URLs and equivalent titles only once', () => {
  const items = parseFeed(rss('openai.com'), NEWS_FEEDS[2]!, NOW);
  assert.equal(deduplicate([...items, ...items]).length, 3);
  assert.equal(deduplicate([items[0]!, { ...items[1]!, title: items[0]!.title + '!' }]).length, 1);
});
test('feed fetch enforces redirect, status and byte limits', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => { assert.equal(init?.redirect, 'error'); return new Response('x'.repeat(2_000_001)); };
    await assert.rejects(fetchFeed(NEWS_FEEDS[0]!), /过大/);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(fetchFeed(NEWS_FEEDS[0]!), /503/);
  } finally { globalThis.fetch = original; }
});
test('retrieval coalesces, caches for 15 minutes and force refresh has cooldown', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.digest(), f.service.digest('ai')]);
  assert.equal(f.calls(), 7); assert.equal(a.cards?.length, 8); assert.equal(b.cards?.length, 3);
  await f.service.digest(); await f.service.digest(undefined, true); assert.equal(f.calls(), 7);
  f.now(NOW + 61000); await f.service.digest(undefined, true); assert.equal(f.calls(), 14);
  f.now(NOW + 120000); await f.service.digest(); assert.equal(f.calls(), 14);
  f.now(NOW + 16 * 60000 + 61000); await f.service.digest(); assert.equal(f.calls(), 21);
});
test('partial and total outages preserve recent cached cards with explicit failures; expired cache is hidden', async () => {
  const f = fixture(); await f.service.digest(); f.offline(); f.now(NOW + 16 * 60000);
  const cached = await f.service.digest(); assert.equal(cached.cards?.length, 8); assert.match(cached.content, /暂不可用/);
  f.now(NOW + 8 * 86400000); assert.equal((await f.service.digest()).cards?.length, 0);
  const partial = fixture({ fetch: async feed => { if (feed.category === 'policy') throw new Error('offline'); return rss(feed.hosts[0]!); } });
  const result = await partial.service.digest(); assert.ok(result.cards!.length > 0); assert.equal(partial.service.status().failures.length, 3);
});
test('news numbering remains stable and pronouns refer to the most recently explained article', async () => {
  const explained: string[] = [];
  const f = fixture({ explain: async item => { explained.push(item.title); return '明确标注的分析'; }, summarize: async () => '简要概览' });
  const digest = await f.service.turn('今天有什么新闻'); assert.match(digest!.content, /AI 概览/);
  await f.service.turn('第二条新闻详细讲讲'); await f.service.turn('这对国内有什么影响');
  assert.equal(explained[0], digest!.cards![1]!.title); assert.equal(explained[1], explained[0]);
  await f.service.turn('第一条新闻详细讲讲'); assert.equal(explained[2], digest!.cards![0]!.title);
  assert.equal(await f.service.turn('第二条任务详细讲讲'), undefined);
  assert.equal(await f.service.turn('新增高优先级任务：阅读AI新闻'), undefined);
  assert.equal(await f.service.turn('提醒我看财经新闻'), undefined);
  assert.equal(await f.service.turn('查询待办任务，包含国际新闻主题'), undefined);
  f.now(NOW + 31 * 60000); assert.match((await f.service.turn('第二条新闻解释一下'))!.content, /请先查询/);
});
test('actions expire/reset, AI failure retains source, cleared context cannot target news', async () => {
  const f = fixture({ summarize: async () => { throw new Error('timeout'); }, explain: async () => { throw new Error('timeout'); } });
  const digest = await f.service.digest(); const action = digest.cards![0]!.actions![0]!.id;
  assert.match(digest.content, /AI 概览暂不可用/); assert.match((await f.service.act(action)).content, /订阅源摘要/);
  f.service.forgetSelection(); assert.equal(await f.service.turn('第二条详细讲讲'), undefined);
  f.service.reset(); assert.match((await f.service.act(action)).content, /过期/);
});
test('settings validate input, serialize concurrent saves and roll back failed save', async () => {
  let saves = 0;
  const f = fixture({ save: async () => { if (++saves === 1) throw new Error('disk'); } });
  const results = await Promise.allSettled([f.service.configure({ enabled: true, time: '09:30' }), f.service.configure({ enabled: false, time: '10:00' })]);
  assert.equal(results[0]!.status, 'rejected'); assert.equal(results[1]!.status, 'fulfilled');
  assert.deepEqual(f.service.status().preferences, { enabled: false, time: '10:00' });
  await assert.rejects(f.service.configure({ enabled: true, time: '24:00' }));
  await assert.rejects(f.service.configure({ enabled: true, time: '09:00', url: 'https://evil' }));
  assert.match((await f.service.turn('开启每日新闻推送，早上8点'))!.content, /08:00/);
  assert.match((await f.service.turn('关闭新闻推送'))!.content, /已关闭/);
});
test('push is off by default, respects block/time, delivers once per Beijing day, survives restart', async () => {
  const f = fixture(); let deliveries = 0;
  const deliver = async (_reply: any, activate: () => boolean) => { assert.equal(activate(), true); deliveries++; };
  await f.service.tick(false, deliver); assert.equal(f.calls(), 0);
  await f.service.configure({ enabled: true, time: '11:00' }); await f.service.tick(false, deliver); assert.equal(f.calls(), 0);
  await f.service.configure({ enabled: true, time: '09:00' }); await f.service.tick(true, deliver); assert.equal(f.calls(), 0);
  await Promise.all([f.service.tick(false, deliver), f.service.tick(false, deliver)]); assert.equal(deliveries, 1);
  await f.service.tick(false, deliver); assert.equal(deliveries, 1);
  const restored = fixture({ load: async () => f.stored() }); await restored.service.restore(); await restored.service.tick(false, deliver); assert.equal(deliveries, 1);
  f.now(NOW + 86400000); await f.service.tick(false, deliver); assert.equal(deliveries, 2, 'next-day digest may deliver remaining unseen articles');
});
test('canceled configuration during retrieval or queued delivery prevents push/context mutation', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ fetch: async feed => { await gate; return rss(feed.hosts[0]!); } });
  await f.service.configure({ enabled: true, time: '09:00' });
  let delivered = false; const ticking = f.service.tick(false, async () => { delivered = true; });
  await f.service.configure({ enabled: false, time: '09:00' }); release(); await ticking; assert.equal(delivered, false);
  const g = fixture(); await g.service.configure({ enabled: true, time: '09:00' });
  await assert.rejects(g.service.tick(false, async (_reply, activate) => {
    assert.equal(await g.service.turn('第二条详细讲讲'), undefined, 'undelivered list never becomes context');
    await g.service.configure({ enabled: false, time: '09:00' }); assert.equal(activate(), false); throw new Error('canceled');
  }));
});
test('failed delivery retries; failed receipt persistence does not repeatedly notify within a session', async () => {
  let failSave = false; const f = fixture({ save: async () => { if (failSave) throw new Error('disk'); } });
  await f.service.configure({ enabled: true, time: '09:00' });
  await assert.rejects(f.service.tick(false, async () => { throw new Error('focus started'); }));
  let delivered = 0;
  await f.service.tick(false, async (_reply, activate) => { activate(); delivered++; failSave = true; });
  await f.service.tick(false, async () => { delivered++; }); assert.equal(delivered, 1);
});
test('news history preserves sources/links but executable grants never restore', async () => {
  const f = fixture(); const message = await f.service.digest('ai');
  const history = parseChatHistory([message]); assert.equal(history[0]!.source, 'news');
  assert.equal(history[0]!.cards![0]!.url, message.cards![0]!.url);
  assert.equal(history[0]!.cards![0]!.actions, undefined);
});
