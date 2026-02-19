import crypto from 'node:crypto';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { getUserByTelegramId, logMessage, recordTokenUsage, touchUser } from '../db.js';
import { ensureUserContainer, restartUserContainer, sanitizeUserCronStore } from '../docker/manager.js';
import { dropOpenClawSession, sendChatToOpenClaw, type OpenClawChatReply } from '../openclaw/chatSessionService.js';
import { OPENCLAW_CHAT_TIMEOUT_MS, OPENCLAW_RETRY_LIMIT } from './constants.js';
import {
  isOpenClawRecoverableError,
  isOpenClawTimeoutError,
  isOpenClawTransientError,
  isTelegramDeliveryError,
  toError
} from './errors.js';
import { ensureTelegramUser } from './identity.js';
import { parseInputsFromContexts, pickPrimaryContext } from './contextInput.js';
import { createReplyStream, finalizeStreamedReply } from './replyFlow.js';
import { stripMediaDirectivesFromText } from './text.js';
import { TelegramStreamProgress } from './streamProgress.js';
import { startTypingLoop } from './typing.js';
import { TelegramUserQueue } from './userQueue.js';
import type { UserRecord } from '../types.js';

const ATTACHMENT_CHAT_TIMEOUT_MS = 240_000;

const userQueue = new TelegramUserQueue();

const resolveChatTimeoutMs = (text: string, attachmentCount: number): number => {
  if (attachmentCount > 0 || /<file\s/i.test(text)) {
    return ATTACHMENT_CHAT_TIMEOUT_MS;
  }
  return OPENCLAW_CHAT_TIMEOUT_MS;
};

const buildTelegramIdempotencyKey = (ctx: Context): string => {
  const chatId = ctx.chat?.id;
  const messageId = ctx.msg?.message_id;
  if (typeof chatId === 'number' && Number.isFinite(chatId) && typeof messageId === 'number') {
    return `tg:${Math.trunc(chatId)}:${Math.trunc(messageId)}`;
  }

  const updateId = (ctx.update as { update_id?: unknown }).update_id;
  if (typeof chatId === 'number' && Number.isFinite(chatId) && typeof updateId === 'number') {
    return `tg:${Math.trunc(chatId)}:u:${Math.trunc(updateId)}`;
  }

  return `tg:fallback:${crypto.randomUUID()}`;
};

const persistUsageLedger = (telegramUserId: number, reply: OpenClawChatReply): void => {
  if (!reply.usage) return;

  const usage = reply.usage;
  recordTokenUsage({
    telegram_user_id: telegramUserId,
    session_key: reply.sessionKey,
    run_id: reply.runId,
    idempotency_key: reply.idempotencyKey || reply.runId,
    provider: usage.provider ?? null,
    model: usage.model ?? null,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens,
    cost_usd: usage.costUsd ?? 0
  });
};

interface ProcessContextOptions {
  runtimeUser?: UserRecord;
  ownerTelegramUserId?: number;
  botToken?: string;
}

export const processContexts = async (contexts: Context[], options: ProcessContextOptions = {}): Promise<void> => {
  const primaryCtx = pickPrimaryContext(contexts);
  if (!primaryCtx) return;

  const ownerTelegramUserId = options.ownerTelegramUserId ?? primaryCtx.from?.id;
  if (!ownerTelegramUserId) return;

  await userQueue.enqueue(ownerTelegramUserId, async () => {
    const user =
      options.runtimeUser && options.runtimeUser.telegram_user_id === ownerTelegramUserId
        ? options.runtimeUser
        : ensureTelegramUser(ownerTelegramUserId, primaryCtx.from?.username ?? null);
    const sourceBotToken = options.botToken || config.telegram.token;

    const parsedInput = await parseInputsFromContexts(contexts, sourceBotToken, ownerTelegramUserId).catch(
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : 'Failed to parse Telegram input.';
        await primaryCtx.reply(message);
        return null;
      }
    );
    if (!parsedInput) return;

    const stopTyping = startTypingLoop(primaryCtx);
    let typingStopped = false;
    const stopTypingOnce = (): void => {
      if (typingStopped) return;
      typingStopped = true;
      stopTyping();
    };

    let textStream: ReturnType<typeof createReplyStream> | null = null;
    let streamProgress = new TelegramStreamProgress();

    try {
      logMessage(ownerTelegramUserId, 'incoming', parsedInput.text);
      touchUser(ownerTelegramUserId);

      const { ready } = await ensureUserContainer(user);
      if (!ready) {
        stopTypingOnce();
        await primaryCtx.reply('AI assistant is unavailable. Please retry later.');
        return;
      }

      textStream = createReplyStream(primaryCtx, stopTypingOnce);
      streamProgress = new TelegramStreamProgress();
      let runtimeUser = getUserByTelegramId(ownerTelegramUserId) ?? user;
      const timeoutMs = resolveChatTimeoutMs(parsedInput.text, parsedInput.attachments.length);
      const idempotencyKey = buildTelegramIdempotencyKey(primaryCtx);
      let reply: OpenClawChatReply | null = null;
      let lastChatError: Error | null = null;

      for (let attempt = 0; attempt <= OPENCLAW_RETRY_LIMIT; attempt += 1) {
        try {
          reply = await sendChatToOpenClaw(runtimeUser, {
            text: parsedInput.text,
            attachments: parsedInput.attachments,
            timeoutMs,
            idempotencyKey,
            onDelta: (text) => {
              const nextText = streamProgress.apply(stripMediaDirectivesFromText(text));
              if (nextText) {
                textStream?.update(nextText);
              }
            }
          });
          break;
        } catch (error: unknown) {
          const normalizedError = toError(error);
          lastChatError = normalizedError;
          const canRetry = attempt < OPENCLAW_RETRY_LIMIT && isOpenClawRecoverableError(normalizedError);
          if (!canRetry) {
            throw normalizedError;
          }

          console.warn(`OpenClaw chat transient error, retrying once: ${normalizedError.message}`);
          dropOpenClawSession(ownerTelegramUserId);
          if (textStream) {
            await textStream.discard().catch(() => undefined);
          }

          const recovery = await ensureUserContainer(runtimeUser);
          if (!recovery.ready) {
            throw normalizedError;
          }
          runtimeUser = getUserByTelegramId(ownerTelegramUserId) ?? runtimeUser;

          textStream = createReplyStream(primaryCtx, stopTypingOnce);
          streamProgress = new TelegramStreamProgress();
        }
      }

      if (!reply) {
        throw lastChatError ?? new Error('OpenClaw response missing');
      }

      sanitizeUserCronStore(runtimeUser.telegram_user_id);
      logMessage(ownerTelegramUserId, 'outgoing', reply.text);
      try {
        persistUsageLedger(runtimeUser.telegram_user_id, reply);
      } catch (usageError: unknown) {
        console.error('Usage ledger persistence failed', usageError);
      }

      stopTypingOnce();
      await finalizeStreamedReply(primaryCtx, runtimeUser, reply, textStream);
    } catch (error: unknown) {
      const normalizedError = toError(error);
      console.error('Message routing error', normalizedError);
      textStream?.stop();
      stopTypingOnce();
      dropOpenClawSession(ownerTelegramUserId);

      if (isOpenClawTimeoutError(normalizedError)) {
        await primaryCtx.reply('Assistant response timed out. Session was reset, please retry.');
        return;
      }

      if (isOpenClawTransientError(normalizedError)) {
        await primaryCtx.reply('Assistant is temporarily unavailable. Session was reset, please retry.');
        return;
      }

      if (isTelegramDeliveryError(normalizedError)) {
        console.error('Telegram delivery error', normalizedError);
        return;
      }

      await primaryCtx.reply('Assistant unavailable. Restarting your container...');

      try {
        const runtimeUser = getUserByTelegramId(ownerTelegramUserId) ?? user;
        await restartUserContainer(runtimeUser);
        await primaryCtx.reply('Container restarted. Please retry your message.');
      } catch (restartError: unknown) {
        console.error('Container restart failed', restartError);
        await primaryCtx.reply('Restart failed. Please contact admin.');
      }
    }
  });
};
