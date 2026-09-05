export interface ChatContext {
  name: string;
  mood: number;
  affection: number;
}

const picks = (items: string[]): string => items[Math.floor(Math.random() * items.length)] ?? items[0] ?? '';

export function replyToChat(raw: string, ctx: ChatContext): string {
  const text = raw.trim();
  if (!text) return picks(['嗯？你想说什么呀～', '我在听哦', '发句话嘛～']);
  const mood = ctx.mood;
  const name = ctx.name;

  if (/你好|嗨|hi|hello|早|晚上好/i.test(text)) {
    if (mood < 30) return picks(['嗯……你好。', '嗨……有点没精神。', `是${name}呀……想休息一下。`]);
    return picks([`嗨嗨～我是${name}！`, '你来啦，好开心！', '嘿嘿，想我了吗？']);
  }
  if (/累|困|睡觉|休息/.test(text)) {
    return picks(['那我陪你歇一会儿～', '要不要让我先去睡一觉给你看？', '打起精神来嘛，摸摸头～']);
  }
  if (/吃|饿|零食|蛋糕|饭/.test(text)) {
    return picks(['想吃蛋糕！', '投喂我嘛～', '肚子已经在叫了。']);
  }
  if (/喜欢|爱你|想你|好看|可爱/.test(text)) {
    if (ctx.affection >= 80) return picks(['我也最喜欢你了！', '嘿嘿，再夸一句嘛', '被你这么说会飘起来的～']);
    return picks(['真的吗？心跳漏了一拍……', '那……那我也有一点喜欢你。', '不许反悔哦。']);
  }
  if (/忙|工作|加班|学习/.test(text)) {
    return picks(['加油呀，做完来找我玩。', '别坐太久，记得起来走走。', '我在旁边陪你，不打扰。']);
  }
  if (/名字|叫什么/.test(text)) {
    return picks([`我叫${name}呀，你忘了吗？`, `记住咯，我是${name}。`]);
  }
  if (/走|散步|运动/.test(text)) {
    return picks(['走走走！', '我去转一圈～', '要一起吗？']);
  }
  if (mood < 30) return picks(['今天有点没精神……陪陪我好不好。', '想被摸摸头。', '……你还在吗？']);
  if (ctx.affection >= 120) return picks(['有你在就好开心。', '再跟我说说话嘛～', '不许冷落我哦。']);
  return picks(['嗯嗯，我记住了。', '然后呢？', '嘿嘿，继续说呀。', '这个我听进去了～', '真的吗？好有意思。']);
}
