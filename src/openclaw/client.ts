import crypto from 'node:crypto';
import { config } from '../config.js';
import type { UserRecord } from '../types.js';
import { extractArtifactReferences, type ArtifactReference } from './artifacts.js';
import { GatewayClient, type GatewayEvent } from './gatewayClient.js';

const CHAT_TIMEOUT_MS = 90_000;

type OpenClawUser = Pick<UserRecord, 'telegram_user_id' | 'container_port' | 'container_id'>;

export interface OpenClawAttachment {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
}

export interface OpenClawChatRequest {
  text: string;
  attachments?: OpenClawAttachment[];
  timeoutMs?: number;
  onDelta?: (text: string) => void;
}

export interface OpenClawChatReply {
  runId: string;
  text: string;
  artifacts: ArtifactReference[];
  messages: OpenClawReplyMessage[];
}

export interface OpenClawReplyMessage {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  channelData?: Record<string, unknown>;
}

export interface OpenClawCronFinishedEvent {
  telegramUserId: number;
  jobId: string;
  status: 'ok' | 'error' | 'skipped';
  summary?: string;
  error?: string;
  runAtMs?: number;
}

interface PendingRun {
  timer: NodeJS.Timeout;
  textBuffer: string;
  artifacts: Map<string, ArtifactReference>;
  onDelta?: (text: string) => void;
  lastDeltaText?: string;
  error?: Error;
}

interface GatewaySession {
  user: OpenClawUser;
  client: GatewayClient;
  sessionKey: string;
  pending: Map<string, PendingRun>;
}

type CronEventHandler = (event: OpenClawCronFinishedEvent) => void | Promise<void>;

const CRON_EVENT_DEDUPE_TTL_MS = 10 * 60_000;
const sessions = new Map<number, GatewaySession>();
const recentCronEvents = new Map<string, number>();
let cronEventHandler: CronEventHandler | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const extractChatText = (message: unknown): string | null => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) return null;

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!isRecord(part)) return null;
        if (typeof part.text === 'string') return part.text;
        return null;
      })
      .filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
};

const cleanupRecentCronEvents = (now: number): void => {
  for (const [key, ts] of recentCronEvents) {
    if (now - ts > CRON_EVENT_DEDUPE_TTL_MS) {
      recentCronEvents.delete(key);
    }
  }
};

const normalizeCronStatus = (value: unknown): OpenClawCronFinishedEvent['status'] | null => {
  return value === 'ok' || value === 'error' || value === 'skipped' ? value : null;
};

const emitCronFinishedEvent = (event: OpenClawCronFinishedEvent): void => {
  if (!cronEventHandler) return;
  Promise.resolve(cronEventHandler(event)).catch((error: unknown) => {
    console.error('Cron event handler failed', error);
  });
};

const buildWsUrl = (user: OpenClawUser): string => {
  return `ws://127.0.0.1:${user.container_port}${config.openclaw.wsPath}`;
};

const getSession = (telegramUserId: number): GatewaySession | undefined => {
  return sessions.get(telegramUserId);
};

const addArtifactsToPending = (pending: PendingRun, artifacts: ArtifactReference[]): void => {
  artifacts.forEach((artifact) => {
    const existing = pending.artifacts.get(artifact.source);
    if (!existing || (existing.kind === 'file' && artifact.kind === 'media')) {
      pending.artifacts.set(artifact.source, artifact);
    }
  });
};

const dedupeArtifacts = (artifacts: ArtifactReference[]): ArtifactReference[] => {
  const map = new Map<string, ArtifactReference>();
  artifacts.forEach((artifact) => {
    const source = artifact.source?.trim();
    if (!source) return;

    const existing = map.get(source);
    if (!existing || (existing.kind === 'file' && artifact.kind === 'media')) {
      map.set(source, { source, kind: artifact.kind });
    }
  });
  return Array.from(map.values());
};

const toReplyMessage = (value: unknown): OpenClawReplyMessage | null => {
  if (!isRecord(value)) return null;
  const message: OpenClawReplyMessage = {};

  if (typeof value.text === 'string' && value.text.trim()) {
    message.text = value.text;
  }
  if (typeof value.mediaUrl === 'string' && value.mediaUrl.trim()) {
    message.mediaUrl = value.mediaUrl;
  }
  if (Array.isArray(value.mediaUrls)) {
    const mediaUrls = value.mediaUrls.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
    );
    if (mediaUrls.length) {
      message.mediaUrls = mediaUrls;
    }
  }
  if (value.audioAsVoice === true) {
    message.audioAsVoice = true;
  }
  if (isRecord(value.channelData)) {
    message.channelData = value.channelData;
  }

  return Object.keys(message).length ? message : null;
};

const toReplyMessages = (value: unknown): OpenClawReplyMessage[] => {
  if (!isRecord(value)) return [];
  const result = isRecord(value.result) ? value.result : null;
  if (!result || !Array.isArray(result.payloads)) return [];

  const messages = result.payloads
    .map((item: unknown) => toReplyMessage(item))
    .filter((item): item is OpenClawReplyMessage => Boolean(item));
  return messages;
};

const artifactsFromReplyMessages = (messages: OpenClawReplyMessage[]): ArtifactReference[] => {
  const artifacts: ArtifactReference[] = [];
  messages.forEach((message) => {
    if (typeof message.mediaUrl === 'string' && message.mediaUrl.trim()) {
      artifacts.push({
        source: message.mediaUrl,
        kind: 'media'
      });
    }
    message.mediaUrls?.forEach((mediaUrl) => {
      if (!mediaUrl.trim()) return;
      artifacts.push({
        source: mediaUrl,
        kind: 'media'
      });
    });
  });
  return dedupeArtifacts(artifacts);
};

const composeReplyText = (messages: OpenClawReplyMessage[], fallbackText: string): string => {
  const texts = messages
    .map((message) => (typeof message.text === 'string' ? message.text.trim() : ''))
    .filter(Boolean);
  if (texts.length) return texts.join('\n\n');
  return fallbackText.trim() || '（无响应内容）';
};

const resolveSession = (user: OpenClawUser): GatewaySession => {
  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required for WebSocket RPC.');
  }

  const existing = getSession(user.telegram_user_id);
  if (existing && existing.user.container_port === user.container_port) {
    existing.user = user;
    return existing;
  }

  if (existing) {
    existing.client.stop();
    sessions.delete(user.telegram_user_id);
  }

  const client = new GatewayClient({
    url: buildWsUrl(user),
    token: config.openclaw.apiKey,
    role: 'operator',
    scopes: ['operator.admin'],
    clientName: 'gateway-client',
    mode: 'backend',
    userAgent: 'pinai-telegram-bot',
    locale: 'en-US',
    caps: ['tool-events'],
    onEvent: (event) => handleGatewayEvent(user.telegram_user_id, event)
  });

  const session: GatewaySession = {
    user,
    client,
    pending: new Map<string, PendingRun>(),
    sessionKey: `telegram:dm:${user.telegram_user_id}`
  };

  sessions.set(user.telegram_user_id, session);
  client.start();
  return session;
};

const settlePending = (
  pendingMap: Map<string, PendingRun>,
  runId: string,
  handler: (pending: PendingRun) => void
): void => {
  const pending = pendingMap.get(runId);
  if (!pending) return;
  handler(pending);
};

const handleChatPayload = (session: GatewaySession, payload: unknown): void => {
  if (!isRecord(payload)) return;

  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  const state = typeof payload.state === 'string' ? payload.state : '';
  const text = extractChatText(payload.message);
  if (!runId) return;

  settlePending(session.pending, runId, (pending) => {
    if (state === 'delta' && text) {
      if (!pending.textBuffer || text.length >= pending.textBuffer.length) {
        pending.textBuffer = text;
      }
      if (text !== pending.lastDeltaText) {
        pending.lastDeltaText = text;
        pending.onDelta?.(text);
      }
      return;
    }

    if (state === 'final' && text) {
      pending.textBuffer = text;
      return;
    }

    if (state === 'error') {
      const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : 'chat error';
      pending.error = new Error(errorMessage);
      return;
    }

    if (state === 'aborted') {
      pending.error = new Error('chat aborted');
    }
  });
};

const handleAgentPayload = (session: GatewaySession, payload: unknown): void => {
  if (!isRecord(payload)) return;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!runId) return;

  settlePending(session.pending, runId, (pending) => {
    const artifacts = extractArtifactReferences(payload);
    if (!artifacts.length) return;
    addArtifactsToPending(pending, artifacts);
  });
};

const handleCronPayload = (telegramUserId: number, payload: unknown): void => {
  if (!isRecord(payload)) return;
  if (payload.action !== 'finished') return;

  const jobId = typeof payload.jobId === 'string' ? payload.jobId.trim() : '';
  const status = normalizeCronStatus(payload.status);
  if (!jobId || !status) return;

  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
  const errorMessage = typeof payload.error === 'string' ? payload.error.trim() : '';
  if (!summary && !(status === 'error' && errorMessage)) return;

  const runAtMs =
    typeof payload.runAtMs === 'number' && Number.isFinite(payload.runAtMs)
      ? Math.trunc(payload.runAtMs)
      : undefined;

  const dedupeSource = `${summary}\n${errorMessage}`;
  const digest = crypto.createHash('sha1').update(dedupeSource).digest('hex');
  const dedupeKey = `${telegramUserId}:${jobId}:${runAtMs ?? 0}:${status}:${digest}`;
  const now = Date.now();
  cleanupRecentCronEvents(now);
  if (recentCronEvents.has(dedupeKey)) return;
  recentCronEvents.set(dedupeKey, now);

  const event: OpenClawCronFinishedEvent = {
    telegramUserId,
    jobId,
    status
  };
  if (summary) event.summary = summary;
  if (errorMessage) event.error = errorMessage;
  if (runAtMs !== undefined) event.runAtMs = runAtMs;

  emitCronFinishedEvent(event);
};

const handleGatewayEvent = (telegramUserId: number, event: GatewayEvent): void => {
  if (!event || typeof event.event !== 'string') return;
  const session = getSession(telegramUserId);
  if (!session) return;

  if (event.event === 'chat') {
    handleChatPayload(session, event.payload);
    return;
  }

  if (event.event === 'agent') {
    handleAgentPayload(session, event.payload);
    return;
  }

  if (event.event === 'cron') {
    handleCronPayload(telegramUserId, event.payload);
  }
};

const normalizeAttachments = (attachments: OpenClawAttachment[] | undefined): OpenClawAttachment[] => {
  if (!attachments?.length) return [];
  return attachments
    .map((item) => {
      const normalized: OpenClawAttachment = {
        content: item.content
      };
      if (typeof item.type === 'string' && item.type.trim()) normalized.type = item.type;
      if (typeof item.mimeType === 'string' && item.mimeType.trim()) normalized.mimeType = item.mimeType;
      if (typeof item.fileName === 'string' && item.fileName.trim()) normalized.fileName = item.fileName;
      return normalized;
    })
    .filter((item) => typeof item.content === 'string' && item.content.length > 0);
};

export const sendChatToOpenClaw = async (
  user: OpenClawUser,
  request: OpenClawChatRequest
): Promise<OpenClawChatReply> => {
  const message = request.text.trim();
  const attachments = normalizeAttachments(request.attachments);
  if (!message && attachments.length === 0) {
    throw new Error('message or attachment required');
  }

  const session = resolveSession(user);
  await session.client.waitForHello();

  const runId = crypto.randomUUID();
  const timeoutMs = request.timeoutMs ?? CHAT_TIMEOUT_MS;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = (error: Error) => reject(error);
  });
  const timeoutHandle = setTimeout(() => {
    rejectTimeout?.(new Error('chat timeout'));
  }, timeoutMs);
  timeoutHandle.unref();

  const pending: PendingRun = {
    timer: timeoutHandle,
    textBuffer: '',
    artifacts: new Map<string, ArtifactReference>()
  };
  if (request.onDelta) pending.onDelta = request.onDelta;
  session.pending.set(runId, pending);

  try {
    const params: Record<string, unknown> = {
      sessionKey: session.sessionKey,
      message,
      channel: 'telegram',
      to: String(user.telegram_user_id),
      deliver: false,
      timeout: timeoutMs,
      idempotencyKey: runId
    };
    if (attachments.length) {
      params.attachments = attachments;
    }

    const rpcPromise = session.client.request<Record<string, unknown>>('agent', params, {
      expectFinal: true
    });
    const finalPayload = await Promise.race([rpcPromise, timeoutPromise]);

    if (pending.error) {
      throw pending.error;
    }

    const messages = toReplyMessages(finalPayload);
    const eventArtifacts = Array.from(pending.artifacts.values());
    const messageArtifacts = artifactsFromReplyMessages(messages);
    const artifacts = dedupeArtifacts([...eventArtifacts, ...messageArtifacts]);
    const text = composeReplyText(messages, pending.textBuffer);

    return {
      runId,
      text,
      artifacts,
      messages
    };
  } finally {
    clearTimeout(timeoutHandle);
    session.pending.delete(runId);
  }
};

export const dropOpenClawSession = (telegramUserId: number): void => {
  const session = sessions.get(telegramUserId);
  if (!session) return;

  for (const [, pending] of session.pending) {
    clearTimeout(pending.timer);
    pending.error = new Error('gateway session dropped');
  }
  session.pending.clear();
  session.client.stop();
  sessions.delete(telegramUserId);
};

export const setOpenClawCronEventHandler = (handler: CronEventHandler | null): void => {
  cronEventHandler = handler;
};
