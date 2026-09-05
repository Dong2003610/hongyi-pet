import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  city?: string;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 从 userData 目录读取 ai-config.json；文件缺失或字段不完整时返回 undefined（回退到本地规则回复）。
export async function loadAiConfig(userDataDir: string): Promise<AiConfig | undefined> {
  try {
    const raw = await readFile(path.join(userDataDir, 'ai-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.enabled === false) return undefined;
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '';
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    if (!baseUrl || !apiKey || !model) return undefined;
    const city = typeof parsed.city === 'string' && parsed.city.trim() ? parsed.city.trim() : undefined;
    const config: AiConfig = { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
    if (city) config.city = city;
    return config;
  } catch {
    return undefined;
  }
}

function chatUrl(baseUrl: string): string {
  return /\/chat\/completions\/?$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}

// 调用 OpenAI 兼容的 chat/completions 接口（豆包/智谱 GLM/DeepSeek/硅基流动等均兼容）。
export async function chatWithAi(config: AiConfig, messages: AiChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(chatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.8,
        max_tokens: 200,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`AI request failed: HTTP ${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI returned empty reply');
    return content.slice(0, 500);
  } finally {
    clearTimeout(timer);
  }
}
