import crypto from 'node:crypto';
import { config } from '../config.js';
import { GatewayClient, type GatewayEvent } from './gatewayClient.js';
import type { UserRecord } from '../types.js';

const CHANNEL_PREFIXES = [
  'WebChat',
  'WhatsApp',
  'Telegram',
  'Signal',
  'Slack',
  'Discord',
  'iMessage',
  'Teams',
  'Matrix',
  'Zalo',
  'Zalo Personal',
  'BlueBubbles'
];

type PushHandler = (text: string) => void;

type GatewayUser = Pick<UserRecord, 'telegram_user_id' | 'container_port'>;

interface PendingChat {
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
  buffer: string;
  timer: NodeJS.Timeout;
}

interface GatewaySession {
  user: GatewayUser;
  client: GatewayClient;
  pending: Map<string, PendingChat>;
  onPush: PushHandler | undefined;
  sessionKey: string;
  lastPushText: string | null;
  lastPushAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const shouldStripPrefix = (prefix: string): boolean => {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(prefix)) return true;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(prefix)) return true;
  return CHANNEL_PREFIXES.some((name) => prefix.startsWith(`${name} `));
};

const stripMetaPrefix = (text: string): string => {
  const match = text.match(/^\[([^\]]+)\]\s*/);
  if (!match) return text;
  const prefix = match[1] ?? '';
  return shouldStripPrefix(prefix) ? text.slice(match[0].length) : text;
};

const extractText = (message: unknown): string | null => {
  if (!isRecord(message)) return null;

  const content = message.content;
  let text: string | null = null;

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!isRecord(part)) return null;
        return part.type === 'text' && typeof part.text === 'string' ? part.text : null;
      })
      .filter((part): part is string => typeof part === 'string');

    if (parts.length) {
      text = parts.join('\n');
    }
  } else if (typeof message.text === 'string') {
    text = message.text;
  }

  if (!text) return null;
  return stripMetaPrefix(text);
};

const isCronSessionKey = (sessionKey: unknown): boolean => {
  if (typeof sessionKey !== 'string') return false;
  const normalized = sessionKey.toLowerCase();
  return normalized.startsWith('cron:') || normalized.includes(':cron:');
};

const sessions = new Map<number, GatewaySession>();

const buildWsUrl = (user: GatewayUser): string =>
  `ws://127.0.0.1:${user.container_port}${config.openclaw.wsPath}`;

const ensureSession = (user: GatewayUser, onPush?: PushHandler): GatewaySession => {
  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required for gateway WebSocket access.');
  }

  const existing = sessions.get(user.telegram_user_id);
  if (existing) {
    existing.onPush = onPush;
    return existing;
  }

  const client = new GatewayClient({
    url: buildWsUrl(user),
    token: config.openclaw.apiKey,
    clientName: 'gateway-client',
    mode: 'backend',
    userAgent: 'pinai-backend',
    locale: 'en-US',
    onEvent: (event) => handleGatewayEvent(user.telegram_user_id, event),
    onClose: () => {}
  });

  const session: GatewaySession = {
    user,
    client,
    pending: new Map<string, PendingChat>(),
    onPush,
    sessionKey: `telegram:${user.telegram_user_id}`,
    lastPushText: null,
    lastPushAt: 0
  };

  sessions.set(user.telegram_user_id, session);
  client.start();
  return session;
};

const formatCronPush = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;

  const action = typeof payload.action === 'string' ? payload.action : '';
  if (action !== 'finished') return null;

  const status = typeof payload.status === 'string' ? payload.status : '';
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  const error = typeof payload.error === 'string' ? payload.error.trim() : '';

  if (status === 'error') {
    return `Cron (error): ${error || summary || 'unknown error'}`;
  }

  if (status === 'skipped') {
    if (!summary && !error) return null;
    return `Cron (skipped): ${summary || error}`;
  }

  if (summary) {
    return `Cron: ${summary}`;
  }

  return null;
};

const handleGatewayEvent = (telegramUserId: number, event: GatewayEvent): void => {
  if (!event || typeof event.event !== 'string') return;

  const session = sessions.get(telegramUserId);
  if (!session) return;

  const payload = event.payload ?? {};

  const pushOnce = (text: string): void => {
    if (!text || !session.onPush) return;

    const now = Date.now();
    if (session.lastPushText === text && now - session.lastPushAt < 5000) {
      return;
    }

    session.lastPushText = text;
    session.lastPushAt = now;
    session.onPush(text);
  };

  if (event.event === 'cron') {
    const cronText = formatCronPush(payload);
    if (cronText) {
      pushOnce(cronText);
    }
    return;
  }

  if (event.event !== 'chat' || !isRecord(payload)) return;
  if (isCronSessionKey(payload.sessionKey)) {
    return;
  }

  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  const state = typeof payload.state === 'string' ? payload.state : '';
  const message = payload.message ?? payload;
  const text = extractText(message);

  if (runId && session.pending.has(runId)) {
    const pending = session.pending.get(runId);
    if (!pending) return;

    if (state === 'delta' && text) {
      if (!pending.buffer || text.length >= pending.buffer.length) {
        pending.buffer = text;
      }
    }

    if (state === 'final') {
      const finalText = text || pending.buffer || '（无响应内容）';
      clearTimeout(pending.timer);
      session.pending.delete(runId);
      pending.resolve(finalText);
    } else if (state === 'error') {
      clearTimeout(pending.timer);
      session.pending.delete(runId);
      const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : 'chat error';
      pending.reject(new Error(errorMessage));
    } else if (state === 'aborted') {
      clearTimeout(pending.timer);
      session.pending.delete(runId);
      pending.reject(new Error('chat aborted'));
    }

    return;
  }

  if (state === 'final' && text) {
    pushOnce(text);
  }
};

export const ensureGatewayBridge = (user: GatewayUser, onPush?: PushHandler): GatewaySession => {
  return ensureSession(user, onPush);
};

export const sendChatViaGateway = async (
  user: GatewayUser,
  text: string,
  onPush?: PushHandler
): Promise<string> => {
  const session = ensureSession(user, onPush);
  await session.client.waitForHello();

  const runId = crypto.randomUUID();
  const timeoutMs = 60000;

  const promise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(runId);
      reject(new Error('chat timeout'));
    }, timeoutMs);

    session.pending.set(runId, { resolve, reject, buffer: '', timer });
  });

  await session.client.request('chat.send', {
    sessionKey: session.sessionKey,
    message: text,
    deliver: false,
    idempotencyKey: runId
  });

  return promise;
};
