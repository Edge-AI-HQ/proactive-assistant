import crypto from 'node:crypto';
import { config } from '../config.js';
import type { UserRecord } from '../types.js';
import { extractArtifactReferences, type ArtifactReference } from './artifacts.js';
import { GatewayClient, type GatewayEvent } from './gatewayClient.js';

const CHAT_TIMEOUT_MS = 90_000;
const ABORT_TIMEOUT_MS = 5_000;

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
  idempotencyKey?: string;
  sessionKey?: string;
  extraParams?: Record<string, unknown>;
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

interface CompletionGate {
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}

interface PendingRun {
  runId: string;
  timer: NodeJS.Timeout;
  keyAliases: Set<string>;
  textBuffer: string;
  artifacts: Map<string, ArtifactReference>;
  messages: OpenClawReplyMessage[];
  completion: CompletionGate;
  onDelta?: (text: string) => void;
  lastDeltaText?: string;
  error?: Error;
  finalPayload?: unknown;
}

interface GatewaySession {
  user: OpenClawUser;
  client: GatewayClient;
  sessionKey: string;
  pending: Map<string, PendingRun>;
}

type CronEventHandler = (event: OpenClawCronFinishedEvent) => void | Promise<void>;
type ChatState = 'delta' | 'final' | 'error' | 'aborted';

const CRON_EVENT_DEDUPE_TTL_MS = 10 * 60_000;
const sessions = new Map<number, GatewaySession>();
const recentCronEvents = new Map<string, number>();
let cronEventHandler: CronEventHandler | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const asNonEmptyString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  return new Error(String(error));
};

const isTimeoutError = (error: Error): boolean => /timeout/i.test(error.message);

const normalizeTimeoutMs = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.trunc(value));
};

const createCompletionGate = (): CompletionGate => {
  let resolvePromise: () => void = () => undefined;
  const gate: CompletionGate = {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => {
      if (gate.settled) return;
      gate.settled = true;
      resolvePromise();
    },
    settled: false
  };
  return gate;
};

const extractChatText = (message: unknown): string | null => {
  if (typeof message === 'string') {
    return message;
  }
  if (!isRecord(message)) return null;

  if (typeof message.text === 'string') {
    return message.text;
  }
  if (typeof message.delta === 'string') {
    return message.delta;
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!isRecord(part)) return null;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.delta === 'string') return part.delta;
        return null;
      })
      .filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (isRecord(content)) {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.delta === 'string') return content.delta;
  }

  return null;
};

const extractRunId = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;
  const candidates: unknown[] = [payload.runId, payload.idempotencyKey, payload.clientRunId, payload.run_id];
  for (const candidate of candidates) {
    const value = asNonEmptyString(candidate);
    if (value) return value;
  }
  return null;
};

const extractPayloadText = (payload: Record<string, unknown>): string | null => {
  const directCandidates: unknown[] = [payload.delta, payload.text, payload.final];
  for (const candidate of directCandidates) {
    const value = asNonEmptyString(candidate);
    if (value) return value;
  }

  const messageText = extractChatText(payload.message);
  if (messageText) return messageText;

  const data = isRecord(payload.data) ? payload.data : null;
  if (!data) return null;

  const nestedCandidates: unknown[] = [data.delta, data.text, data.final];
  for (const candidate of nestedCandidates) {
    const value = asNonEmptyString(candidate);
    if (value) return value;
  }

  const nestedMessageText = extractChatText(data.message);
  if (nestedMessageText) return nestedMessageText;

  return null;
};

const extractPayloadError = (payload: Record<string, unknown>): string | null => {
  const direct = asNonEmptyString(payload.errorMessage) ?? asNonEmptyString(payload.error);
  if (direct) return direct;

  const data = isRecord(payload.data) ? payload.data : null;
  if (!data) return null;

  return asNonEmptyString(data.errorMessage) ?? asNonEmptyString(data.error);
};

const resolveChatState = (payload: Record<string, unknown>): ChatState | null => {
  const state = asNonEmptyString(payload.state)?.toLowerCase();
  if (state === 'delta' || state === 'final' || state === 'error' || state === 'aborted') {
    return state;
  }

  const stream = asNonEmptyString(payload.stream)?.toLowerCase();
  if (stream === 'error') return 'error';

  const data = isRecord(payload.data) ? payload.data : null;
  const lifecycleStatus = asNonEmptyString(data?.status)?.toLowerCase();
  if (stream === 'lifecycle' && lifecycleStatus) {
    if (['done', 'completed', 'complete', 'finished', 'ok'].includes(lifecycleStatus)) {
      return 'final';
    }
    if (['error', 'failed'].includes(lifecycleStatus)) {
      return 'error';
    }
    if (['aborted', 'cancelled'].includes(lifecycleStatus)) {
      return 'aborted';
    }
  }

  if (stream === 'assistant' && extractPayloadText(payload)) {
    return 'delta';
  }

  return null;
};

const mergeDeltaText = (existing: string, incoming: string): string => {
  const next = incoming.trimEnd();
  if (!next) return existing;
  if (!existing) return next;

  if (next === existing) return existing;
  if (next.startsWith(existing)) return next;
  if (existing.startsWith(next)) return next.length >= existing.length * 0.8 ? next : existing;
  if (existing.endsWith(next)) return existing;

  const looksLikeSnapshot =
    next.length >= 120 && (next.includes('\n') || next.startsWith('#') || next.includes('|'));
  if (looksLikeSnapshot) {
    return next;
  }

  const maxOverlap = Math.min(existing.length, next.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 1; size -= 1) {
    if (existing.slice(-size) === next.slice(0, size)) {
      overlap = size;
      break;
    }
  }
  if (overlap > 0) {
    return `${existing}${next.slice(overlap)}`;
  }

  return `${existing}${next}`;
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

const replyMessageKey = (message: OpenClawReplyMessage): string => {
  const text = message.text?.trim() ?? '';
  const mediaUrl = message.mediaUrl?.trim() ?? '';
  const mediaUrls = (message.mediaUrls ?? []).map((item) => item.trim()).filter(Boolean).join('|');
  const voice = message.audioAsVoice === true ? '1' : '0';
  return `${text}\n${mediaUrl}\n${mediaUrls}\n${voice}`;
};

const dedupeReplyMessages = (messages: OpenClawReplyMessage[]): OpenClawReplyMessage[] => {
  const map = new Map<string, OpenClawReplyMessage>();
  for (const message of messages) {
    const key = replyMessageKey(message);
    if (!key.trim()) continue;
    if (!map.has(key)) {
      map.set(key, message);
    }
  }
  return Array.from(map.values());
};

const collectReplyNodes = (value: unknown): unknown[] => {
  if (!isRecord(value)) return [];

  const result = isRecord(value.result) ? value.result : null;
  const nodes: unknown[] = [];

  const collectArray = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    nodes.push(...candidate);
  };

  collectArray(value.payloads);
  collectArray(value.messages);
  if (isRecord(value.message)) {
    nodes.push(value.message);
  }

  if (result) {
    collectArray(result.payloads);
    collectArray(result.messages);
    if (isRecord(result.message)) {
      nodes.push(result.message);
    }
  }

  return nodes;
};

const toReplyMessages = (value: unknown): OpenClawReplyMessage[] => {
  const messages = collectReplyNodes(value)
    .map((item) => toReplyMessage(item))
    .filter((item): item is OpenClawReplyMessage => Boolean(item));
  return dedupeReplyMessages(messages);
};

const appendPendingMessages = (pending: PendingRun, messages: OpenClawReplyMessage[]): void => {
  if (!messages.length) return;
  pending.messages = dedupeReplyMessages([...pending.messages, ...messages]);
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

const attachPendingRun = (session: GatewaySession, pending: PendingRun, runId: string): void => {
  const normalized = runId.trim();
  if (!normalized) return;
  session.pending.set(normalized, pending);
  pending.keyAliases.add(normalized);
  pending.runId = normalized;
};

const detachPendingRun = (session: GatewaySession, pending: PendingRun): void => {
  for (const alias of pending.keyAliases) {
    if (session.pending.get(alias) === pending) {
      session.pending.delete(alias);
    }
  }
  pending.keyAliases.clear();
};

const markPendingDelta = (pending: PendingRun, text: string): void => {
  const merged = mergeDeltaText(pending.textBuffer, text);
  if (merged === pending.textBuffer) return;
  pending.textBuffer = merged;

  if (pending.textBuffer !== pending.lastDeltaText) {
    pending.lastDeltaText = pending.textBuffer;
    pending.onDelta?.(pending.textBuffer);
  }
};

const markPendingFinal = (pending: PendingRun, text: string): void => {
  const finalText = text.trimEnd();
  if (!finalText) return;

  if (finalText.length >= pending.textBuffer.length || finalText.startsWith(pending.textBuffer)) {
    pending.textBuffer = finalText;
  }

  if (pending.textBuffer !== pending.lastDeltaText) {
    pending.lastDeltaText = pending.textBuffer;
    pending.onDelta?.(pending.textBuffer);
  }
};

const settlePendingCompletion = (pending: PendingRun): void => {
  pending.completion.resolve();
};

const handleChatPayload = (session: GatewaySession, payload: unknown): void => {
  if (!isRecord(payload)) return;

  const runId = extractRunId(payload);
  if (!runId) return;

  const pending = session.pending.get(runId);
  if (!pending) return;

  const state = resolveChatState(payload);
  const text = extractPayloadText(payload);
  if (state === 'delta' && text) {
    markPendingDelta(pending, text);
  } else if (state === 'final' && text) {
    markPendingFinal(pending, text);
  }

  appendPendingMessages(pending, toReplyMessages(payload));
  addArtifactsToPending(pending, extractArtifactReferences(payload));

  if (state === 'error') {
    pending.error = new Error(extractPayloadError(payload) ?? 'chat error');
    pending.finalPayload = payload;
    settlePendingCompletion(pending);
    return;
  }

  if (state === 'aborted') {
    pending.error = new Error(extractPayloadError(payload) ?? 'chat aborted');
    pending.finalPayload = payload;
    settlePendingCompletion(pending);
    return;
  }

  if (state === 'final') {
    pending.finalPayload = payload;
    settlePendingCompletion(pending);
  }
};

const handleAgentPayload = (session: GatewaySession, payload: unknown): void => {
  if (!isRecord(payload)) return;

  const runId = extractRunId(payload);
  if (!runId) return;

  const pending = session.pending.get(runId);
  if (!pending) return;

  const sanitizedMessages = toReplyMessages(payload).map((message) => {
    const mediaOnly: OpenClawReplyMessage = {};
    if (message.mediaUrl) mediaOnly.mediaUrl = message.mediaUrl;
    if (message.mediaUrls?.length) mediaOnly.mediaUrls = message.mediaUrls;
    if (message.audioAsVoice === true) mediaOnly.audioAsVoice = true;
    if (message.channelData) mediaOnly.channelData = message.channelData;
    return Object.keys(mediaOnly).length > 0 ? mediaOnly : null;
  });
  appendPendingMessages(
    pending,
    sanitizedMessages.filter((message): message is OpenClawReplyMessage => message !== null)
  );
  addArtifactsToPending(pending, extractArtifactReferences(payload));

  const state = resolveChatState(payload);
  if (state === 'error') {
    pending.error = new Error(extractPayloadError(payload) ?? 'agent error');
    pending.finalPayload = payload;
    settlePendingCompletion(pending);
    return;
  }

  if (state === 'aborted') {
    pending.error = new Error(extractPayloadError(payload) ?? 'agent aborted');
    pending.finalPayload = payload;
    settlePendingCompletion(pending);
  }
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

const buildChatSendParams = (args: {
  sessionKey: string;
  message: string;
  runId: string;
  timeoutMs: number;
  attachments: OpenClawAttachment[];
  extraParams?: Record<string, unknown>;
}): Record<string, unknown> => {
  const params: Record<string, unknown> = {
    sessionKey: args.sessionKey,
    message: args.message,
    deliver: false,
    timeoutMs: args.timeoutMs,
    idempotencyKey: args.runId
  };

  if (args.attachments.length) {
    params.attachments = args.attachments;
  }

  if (args.extraParams) {
    Object.assign(params, args.extraParams);
  }

  return params;
};

const bestEffortAbortRun = async (session: GatewaySession, runId: string, sessionKey: string): Promise<void> => {
  try {
    await session.client.request('chat.abort', { sessionKey, runId }, { timeoutMs: ABORT_TIMEOUT_MS });
  } catch {
    // Best effort cleanup only.
  }
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
    onEvent: (event) => handleGatewayEvent(user.telegram_user_id, event),
    requestTimeoutMs: CHAT_TIMEOUT_MS + 15_000
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

  const timeoutMs = normalizeTimeoutMs(request.timeoutMs, CHAT_TIMEOUT_MS);
  const runId = asNonEmptyString(request.idempotencyKey) ?? crypto.randomUUID();
  const sessionKey = asNonEmptyString(request.sessionKey) ?? session.sessionKey;

  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = (error: Error) => reject(error);
  });
  const timeoutHandle = setTimeout(() => {
    rejectTimeout?.(new Error('chat timeout'));
  }, timeoutMs);
  timeoutHandle.unref();

  const pending: PendingRun = {
    runId,
    timer: timeoutHandle,
    keyAliases: new Set<string>(),
    textBuffer: '',
    artifacts: new Map<string, ArtifactReference>(),
    messages: [],
    completion: createCompletionGate()
  };
  if (request.onDelta) pending.onDelta = request.onDelta;

  attachPendingRun(session, pending, runId);

  try {
    const chatSendArgs: {
      sessionKey: string;
      message: string;
      runId: string;
      timeoutMs: number;
      attachments: OpenClawAttachment[];
      extraParams?: Record<string, unknown>;
    } = {
      sessionKey,
      message,
      runId: pending.runId,
      timeoutMs,
      attachments
    };
    if (request.extraParams) {
      chatSendArgs.extraParams = request.extraParams;
    }
    const params = buildChatSendParams(chatSendArgs);
    const ackPayload = await Promise.race([
      session.client.request<Record<string, unknown>>('chat.send', params, {
        timeoutMs: Math.min(timeoutMs, 20_000)
      }),
      timeoutPromise
    ]);

    const ackRunId = extractRunId(ackPayload);
    if (ackRunId) {
      attachPendingRun(session, pending, ackRunId);
    }

    await Promise.race([pending.completion.promise, timeoutPromise]);
    const finalPayload = pending.finalPayload ?? ackPayload;

    if (pending.error) {
      throw pending.error;
    }

    const payloadMessages = toReplyMessages(finalPayload);
    const messages = dedupeReplyMessages([...pending.messages, ...payloadMessages]);

    const eventArtifacts = Array.from(pending.artifacts.values());
    const payloadArtifacts = dedupeArtifacts(extractArtifactReferences(finalPayload));
    const messageArtifacts = artifactsFromReplyMessages(messages);
    const artifacts = dedupeArtifacts([...eventArtifacts, ...payloadArtifacts, ...messageArtifacts]);

    const text = composeReplyText(messages, pending.textBuffer);

    return {
      runId: pending.runId,
      text,
      artifacts,
      messages
    };
  } catch (error: unknown) {
    const normalizedError = toError(error);
    pending.error = normalizedError;

    if (isTimeoutError(normalizedError)) {
      await bestEffortAbortRun(session, pending.runId, sessionKey);
    }

    throw normalizedError;
  } finally {
    clearTimeout(timeoutHandle);
    detachPendingRun(session, pending);
  }
};

export const dropOpenClawSession = (telegramUserId: number): void => {
  const session = sessions.get(telegramUserId);
  if (!session) return;

  for (const [, pending] of session.pending) {
    clearTimeout(pending.timer);
    pending.error = new Error('gateway session dropped');
    settlePendingCompletion(pending);
  }
  session.pending.clear();
  session.client.stop();
  sessions.delete(telegramUserId);
};

export const setOpenClawCronEventHandler = (handler: CronEventHandler | null): void => {
  cronEventHandler = handler;
};
