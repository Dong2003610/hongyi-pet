import type { InteractionSpec } from '../shared/contracts';
import { chatWithAi, type AiChatMessage, type AiConfig } from './ai-chat';

export interface InteractionReplyContext {
  name: string;
  personality: string[];
  mood: number;
  affection: number;
}

const localReplies: Record<string, string[]> = {
  chat: [
    '今日小纸条：慢慢来也算在前进呀。',
    '如果心情有颜色，你今天会选哪一种？',
    '给今天起个电影名吧，我先选《再来一块饼干》！',
    '我宣布：认真休息也是一种超能力。',
    '今天有没有一件小事，让你偷偷开心了一下？',
    '脑袋偶尔放空，是在给灵感腾座位～',
    '桌面巡逻完毕，发现一个值得夸夸的你。',
    '小挑战：看看窗外，找一件你喜欢的颜色。',
    '如果能给明天寄一句话，你会写什么？',
    '今日份勇气到账：先做一点点就很棒！',
  ],
  'pet-head': [
    '头顶的小天线收到温柔信号啦～',
    '摸摸充电中……快乐电量加一格！',
    '头发可以乱，开心必须到位。',
    '嘿嘿，这个摸头手法，我给满分！',
    '收到！回赠你一颗看不见的小爱心。',
    '再摸就要变成一颗幸福的小团子啦。',
    '刚才还在发呆，现在在偷偷乐。',
    '今天的温柔额度，被你加满啦。',
  ],
  'feed-snack': [
    '啊呜！这一口叫作快乐。',
    '小肚子收到一份美味快递～',
    '我有两个胃，一个装饭，一个装小点心。',
    '吃饱才有力气陪你摸鱼，嘿嘿。',
    '谢谢投喂！给你颁发最佳饲养员勋章。',
    '这份好吃的，要写进我的快乐日记！',
    '腮帮子忙着呢，先用眼睛说谢谢。',
    '你也记得好好吃饭呀，一起补充能量。',
  ],
  'take-walk': [
    '桌面探险队出发！目的地：开心。',
    '小步小步走，烦恼慢慢溜。',
    '让我巡视一下今天的桌面领地～',
    '腿脚活动一下，灵感说不定就跟来了。',
    '走两步！顺便把呆毛吹得更精神。',
    '我负责散步，你负责伸个懒腰，成交？',
    '今天也要给小鞋子安排一点工作。',
    '前方没有大事，只有一只散步的小可爱。',
  ],
  'go-sleep': [
    '先去梦里看看，有没有免费的小蛋糕。',
    '小脑袋暂停营业，醒来继续陪你。',
    '把烦恼折好放一边，我去充个电～',
    '呼……梦里的云朵应该很适合当枕头。',
    '申请一场小睡，批准人是我的眼皮。',
    '睡前把今天的小开心放进梦里。',
    '待机模式启动，请勿偷吃我的梦中点心。',
    '闭眼休息一会儿，你也别太累呀。',
  ],
};

const chatThemes = [
  '今日一句：原创一句温柔的小鼓励，不引用名人，不说教。',
  '一个和桌面生活有关的俏皮话或轻松小笑话。',
  '问用户一个轻松、有想象力的小问题，不询问隐私。',
  '给一个当下就能完成的轻松小挑战，不宣称已替用户执行。',
];

function cleanReply(reply: string): string {
  // This channel is speech only: never display or execute a chat action payload.
  const speech = reply.split('【设定提醒】')[0] ?? '';
  const clean = speech.replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().replace(/^[“"「]|[”"」]$/g, '').trim();
  if (!clean || /^[\[{<]/.test(clean)) return '';
  const characters = Array.from(clean);
  return characters.length > 40 ? `${characters.slice(0, 39).join('')}…` : clean;
}

export class InteractionReplyService {
  private readonly recent = new Map<string, string[]>();
  private active?: AbortController;
  private completion?: Promise<void>;
  private generation = 0;
  private lastRequestAt = -Infinity;
  private lastDailyDate = '';
  private themeIndex = 1;

  constructor(private readonly options: {
    generate?: typeof chatWithAi;
    now?: () => number;
    random?: () => number;
    timeoutMs?: number;
    cooldownMs?: number;
  } = {}) {}

  cancel(): void {
    this.generation += 1;
    this.active?.abort();
    this.active = undefined;
  }

  private remember(id: string, reply: string): void {
    this.recent.set(id, [...(this.recent.get(id) ?? []).filter((item) => item !== reply), reply].slice(-8));
  }

  fallback(interaction: InteractionSpec): string {
    this.cancel();
    const pool = [...new Set([...(localReplies[interaction.id] ?? []), ...interaction.feedback])].filter(Boolean);
    const recent = this.recent.get(interaction.id) ?? [];
    const fresh = pool.filter((reply) => !recent.includes(reply));
    const candidates = fresh.length ? fresh : pool.filter((reply) => reply !== recent.at(-1));
    const choices = candidates.length ? candidates : pool;
    const index = Math.floor((this.options.random ?? Math.random)() * choices.length);
    const reply = choices[index] ?? interaction.label;
    this.remember(interaction.id, reply);
    return reply;
  }

  async enhance(interaction: InteractionSpec, context: InteractionReplyContext, config: AiConfig | undefined,
    onReply: (reply: string) => void): Promise<void> {
    const generation = this.generation;
    // fallback() aborts synchronously; let that request finish its cleanup before
    // starting this interaction's request. A newer click supersedes this waiter.
    if (this.completion && !this.active) await this.completion;
    const now = (this.options.now ?? Date.now)();
    // Rapid interactions still get immediate fresh local replies, without a request queue.
    if (!config || this.completion || generation !== this.generation
      || now - this.lastRequestAt < (this.options.cooldownMs ?? 3000)) return;
    this.lastRequestAt = now;
    let complete!: () => void;
    this.completion = new Promise<void>((resolve) => { complete = resolve; });
    const controller = new AbortController();
    this.active = controller;
    const timeoutMs = this.options.timeoutMs ?? 8000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort!: () => void;
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const date = new Date(now);
    const dateKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    const isDaily = interaction.id === 'chat' && this.lastDailyDate !== dateKey;
    const theme = interaction.id === 'chat'
      ? chatThemes[isDaily ? 0 : 1 + (this.themeIndex++ - 1) % (chatThemes.length - 1)]!
      : '自然回应刚刚的互动，加入一点小想象或调皮的细节，不要像菜单提示。';
    const messages: AiChatMessage[] = [{
      role: 'system',
      content: [
        `你是桌面宠物“${context.name}”，性格：${context.personality.join('、')}。`,
        `心情 ${context.mood}/100，好感度 ${context.affection}/300。`,
        `当前本地时间：${dateKey} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}。`,
        '用户刚刚通过互动菜单与你互动，请以第一人称说一句简短、有趣的中文回应。',
        '建议 15～35 字，最多 40 字，只给一句可直接展示的话，不要标题、Markdown 或动作描述。',
        '这是日常陪伴，不处理命令；不要声称设置提醒、操作文件或完成任务，不要输出 JSON 或工具协议。',
        '不编造用户经历、实时天气、新闻或名人名言；不必在每句话里重复名字或时间。',
      ].join('\n'),
    }, {
      role: 'user',
      content: [`互动：${interaction.label}（${interaction.id}）。`, `这次的灵感方向：${theme}`,
        `避免重复或近似这些刚说过的话：${JSON.stringify(this.recent.get(interaction.id) ?? [])}`].join('\n'),
    }];
    try {
      const raw = await Promise.race([
        (this.options.generate ?? chatWithAi)(config, messages, {
          signal: controller.signal, timeoutMs, temperature: 1, maxTokens: 160,
        }),
        aborted,
      ]);
      if (raw === undefined || controller.signal.aborted || this.active !== controller) return;
      const reply = cleanReply(raw);
      if (!reply || (this.recent.get(interaction.id) ?? []).includes(reply)) return;
      this.remember(interaction.id, reply);
      if (isDaily) this.lastDailyDate = dateKey;
      onReply(reply);
    } catch {
      // The local reply is already visible; a network failure must not interrupt the pet.
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (this.active === controller) this.active = undefined;
      this.completion = undefined;
      complete();
    }
  }
}
