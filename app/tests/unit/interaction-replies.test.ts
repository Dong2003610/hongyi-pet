import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionReplyService } from '../../src/main/interaction-replies';
import { chatWithAi, type AiChatMessage, type AiChatOptions } from '../../src/main/ai-chat';
import type { InteractionSpec } from '../../src/shared/contracts';

const chat: InteractionSpec = {
  id: 'chat', emoji: '💬', label: '陪我聊聊天', stateId: 'notify', durationMs: 2000,
  affectionGain: 2, feedback: ['我在听呢～'],
};
const context = { name: '小桃', personality: ['活泼', '调皮'], mood: 86, affection: 24 };
const config = { baseUrl: 'https://example.invalid/v1', apiKey: 'test-only', model: 'mock-model' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('local interaction replies avoid the last eight lines even with deterministic randomness', () => {
  const service = new InteractionReplyService({ random: () => 0 });
  for (const id of ['chat', 'pet-head', 'feed-snack', 'take-walk', 'go-sleep']) {
    const replies = Array.from({ length: 24 }, () => service.fallback({ ...chat, id }));
    for (let i = 0; i < replies.length; i += 1) {
      assert.ok(replies[i]);
      assert.ok(!replies.slice(Math.max(0, i - 8), i).includes(replies[i]!));
    }
  }
});

test('fallback is available immediately and AI uses only the interaction context', async () => {
  const response = deferred<string>();
  let messages: AiChatMessage[] = [];
  let options: AiChatOptions | undefined;
  const service = new InteractionReplyService({
    now: () => new Date(2026, 8, 11, 8, 30).getTime(),
    generate: async (_config, sent, sentOptions) => { messages = sent; options = sentOptions; return response.promise; },
  });
  const fallback = service.fallback(chat);
  const replies: string[] = [];
  const pending = service.enhance(chat, context, config, (reply) => replies.push(reply));
  assert.ok(fallback);
  assert.deepEqual(replies, []);
  assert.equal(messages.length, 2);
  assert.match(messages[0]!.content, /小桃.*活泼、调皮/);
  assert.match(messages[0]!.content, /心情 86\/100，好感度 24\/300/);
  assert.match(messages[0]!.content, /2026-9-11 08:30/);
  assert.match(messages[0]!.content, /建议 15～35 字，最多 40 字/);
  assert.match(messages[1]!.content, /陪我聊聊天/);
  assert.match(messages[1]!.content, /今日一句/);
  assert.equal(options?.timeoutMs, 8000);
  assert.equal(options?.maxTokens, 160);
  response.resolve('今日小纸条：把小小的进步也算进去呀。');
  await pending;
  assert.deepEqual(replies, ['今日小纸条：把小小的进步也算进去呀。']);
});

test('no AI configuration makes no request and leaves the local response in place', async () => {
  const service = new InteractionReplyService({ generate: async () => { assert.fail('must not request AI'); } });
  assert.ok(service.fallback(chat));
  await service.enhance(chat, context, undefined, () => assert.fail('must keep local reply'));
});

test('only one AI request runs at a time and requests have a three-second cooldown', async () => {
  let now = 0;
  let requests = 0;
  const response = deferred<string>();
  const service = new InteractionReplyService({ now: () => now, generate: async () => { requests += 1; return response.promise; } });
  const first = service.enhance(chat, context, config, () => {});
  now = 4000;
  await service.enhance(chat, context, config, () => {});
  assert.equal(requests, 1, 'a slow request must not overlap with another');
  response.resolve('云朵在排队等我下班。');
  await first;
  await service.enhance(chat, context, config, () => {});
  assert.equal(requests, 2);
  now = 6999;
  await service.enhance(chat, context, config, () => {});
  assert.equal(requests, 2, 'cooldown applies even when the last request finished');
  now = 7000;
  await service.enhance(chat, context, config, () => {});
  assert.equal(requests, 3);
});

test('a new interaction cancels and discards the old response even if its provider ignores abort', async () => {
  let now = 0;
  let signal: AbortSignal | undefined;
  const oldResponse = deferred<string>();
  let requests = 0;
  const service = new InteractionReplyService({
    now: () => now,
    generate: async (_config, _messages, options) => {
      requests += 1;
      if (requests === 1) { signal = options?.signal; return oldResponse.promise; }
      return '啊呜！快乐又多了一口。';
    },
  });
  const replies: string[] = [];
  service.fallback(chat);
  const first = service.enhance(chat, context, config, (reply) => replies.push(reply));
  const snack = { ...chat, id: 'feed-snack', label: '喂吃的' };
  now = 3000;
  assert.ok(service.fallback(snack));
  assert.equal(signal?.aborted, true);
  // main calls fallback(), sends the activity, and immediately starts enhance()
  // without awaiting the previous cancelled request.
  const second = service.enhance(snack, context, config, (reply) => replies.push(reply));
  await Promise.all([first, second]);
  assert.equal(requests, 2);
  oldResponse.resolve('这是过时的聊天回复。');
  await Promise.resolve();
  assert.deepEqual(replies, ['啊呜！快乐又多了一口。']);
});

test('when multiple clicks interrupt cancellation cleanup only the latest starts AI', async () => {
  let now = 0;
  const requested: string[] = [];
  const replies: string[] = [];
  const oldResponse = deferred<string>();
  const service = new InteractionReplyService({
    now: () => now,
    generate: async (_config, messages) => {
      requested.push(messages[1]!.content);
      return requested.length === 1 ? oldResponse.promise : '小脑袋先休息一下，梦里见。';
    },
  });
  service.fallback(chat);
  const first = service.enhance(chat, context, config, (reply) => replies.push(reply));
  now = 3000;
  const snack = { ...chat, id: 'feed-snack', label: '喂吃的' };
  service.fallback(snack);
  const superseded = service.enhance(snack, context, config, (reply) => replies.push(reply));
  const sleep = { ...chat, id: 'go-sleep', label: '让她睡觉' };
  service.fallback(sleep);
  const latest = service.enhance(sleep, context, config, (reply) => replies.push(reply));
  await Promise.all([first, superseded, latest]);
  assert.equal(requested.length, 2);
  assert.match(requested[1]!, /go-sleep/);
  oldResponse.resolve('过时回复');
  await Promise.resolve();
  assert.deepEqual(replies, ['小脑袋先休息一下，梦里见。']);
});

test('timeouts and network failures keep the fallback without an unhandled rejection', async () => {
  let signal: AbortSignal | undefined;
  const service = new InteractionReplyService({
    timeoutMs: 10,
    generate: async (_config, _messages, options) => {
      signal = options?.signal;
      return new Promise<string>(() => {});
    },
  });
  const fallback = service.fallback(chat);
  await service.enhance(chat, context, config, () => assert.fail('timed-out reply must not display'));
  assert.ok(fallback);
  assert.equal(signal?.aborted, true);
  const failing = new InteractionReplyService({ generate: async () => { throw new Error('offline'); } });
  await failing.enhance(chat, context, config, () => assert.fail('failed reply must not display'));
});

test('chat rotates inspiration and starts a new daily phrase on the next local date', async () => {
  let now = new Date(2026, 8, 11, 8, 30).getTime();
  const prompts: string[] = [];
  const service = new InteractionReplyService({
    now: () => now,
    generate: async (_config, messages) => { prompts.push(messages[1]!.content); return `这是第${prompts.length}句新灵感。`; },
  });
  for (let i = 0; i < 4; i += 1) {
    await service.enhance(chat, context, config, () => {});
    now += 3000;
  }
  assert.match(prompts[0]!, /今日一句/);
  assert.match(prompts[1]!, /小笑话/);
  assert.match(prompts[2]!, /小问题/);
  assert.match(prompts[3]!, /小挑战/);
  now = new Date(2026, 8, 12, 8, 30).getTime();
  await service.enhance(chat, context, config, () => {});
  assert.match(prompts[4]!, /今日一句/);
});

test('AI speech is bounded, omits action payloads, and does not repeat a recent reply', async () => {
  let now = 0;
  const rawReplies = [
    '<think>internal</think> “小步也算数。”\n【设定提醒】{"text":"private action"}',
    '小步也算数。',
    '【设定提醒】{"text":"private action"}',
    '🍰'.repeat(90),
  ];
  const service = new InteractionReplyService({ now: () => now, generate: async () => rawReplies.shift()! });
  const replies: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await service.enhance(chat, context, config, (reply) => replies.push(reply));
    now += 3000;
  }
  assert.equal(replies[0], '小步也算数。');
  assert.equal(replies.length, 2);
  assert.equal(Array.from(replies[1]!).length, 40);
  assert.ok(replies[1]!.endsWith('…'));
});

test('AI transport forwards cancellation and preserves default chat settings', async () => {
  const originalFetch = globalThis.fetch;
  const request = deferred<void>();
  let body: { temperature?: number; max_tokens?: number } = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init?.body as string);
    request.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  try {
    const controller = new AbortController();
    const pending = chatWithAi(config, [{ role: 'user', content: '你好' }], { signal: controller.signal });
    await request.promise;
    assert.equal(body.temperature, 0.8);
    assert.equal(body.max_tokens, 320);
    controller.abort();
    await assert.rejects(pending, /aborted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
