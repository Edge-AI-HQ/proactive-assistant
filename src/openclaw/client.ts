import { config } from '../config.js';
import type { UserRecord } from '../types.js';

type OpenAIMessage = {
  role: 'user';
  content: string;
};

type OpenAIChatPayload = {
  model: string;
  messages: OpenAIMessage[];
  user: string;
};

type LegacyChatPayload = {
  message: string;
  user_id: string;
};

type OpenClawPayload = OpenAIChatPayload | LegacyChatPayload;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const buildPayload = (text: string, userId: number): OpenClawPayload => {
  if (config.openclaw.httpMode === 'openai') {
    return {
      model: 'openclaw',
      messages: [{ role: 'user', content: text }],
      user: String(userId)
    };
  }
  return { message: text, user_id: String(userId) };
};

const extractReply = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (!isRecord(data)) return '（无响应内容）';

  const directKeys = ['reply', 'text', 'message', 'content'] as const;
  for (const key of directKeys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }

  const choices = data.choices;
  if (Array.isArray(choices)) {
    const first = choices[0];
    if (isRecord(first)) {
      const text = first.text;
      if (typeof text === 'string') return text;

      const message = first.message;
      if (isRecord(message) && typeof message.content === 'string') {
        return message.content;
      }
    }
  }

  return JSON.stringify(data);
};

export const sendMessageToOpenClaw = async (
  user: Pick<UserRecord, 'container_port' | 'telegram_user_id'>,
  text: string
): Promise<string> => {
  const url = `http://127.0.0.1:${user.container_port}${config.openclaw.httpPath}`;
  const payload = buildPayload(text, user.telegram_user_id);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.openclaw.apiKey) {
    headers.Authorization = `Bearer ${config.openclaw.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const contentType = response.headers.get('content-type') || '';
  const data: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const errorText = typeof data === 'string' ? data : JSON.stringify(data);
    throw new Error(`OpenClaw error ${response.status}: ${errorText}`);
  }

  return extractReply(data);
};
