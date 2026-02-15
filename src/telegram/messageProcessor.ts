import crypto from 'node:crypto';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { getUserByTelegramId, logMessage, touchUser } from '../db.js';
import { ensureUserContainer, restartUserContainer, sanitizeUserCronStore } from '../docker/manager.js';
import { dropOpenClawSession, sendChatToOpenClaw, type OpenClawChatReply } from '../openclaw/client.js';
import { LOGIN_REQUIRED_MESSAGE, OPENCLAW_CHAT_TIMEOUT_MS, OPENCLAW_RETRY_LIMIT } from './constants.js';
import {
  isOpenClawRecoverableError,
  isOpenClawTimeoutError,
  isOpenClawTransientError,
  isTelegramDeliveryError,
  toError
} from './errors.js';
import { parseInputsFromContexts, pickPrimaryContext } from './contextInput.js';
import { createReplyStream, finalizeStreamedReply } from './replyFlow.js';
import { stripMediaDirectivesFromText } from './text.js';
import { TelegramStreamProgress } from './streamProgress.js';
import { startTypingLoop } from './typing.js';
import { TelegramUserQueue } from './userQueue.js';

const ATTACHMENT_CHAT_TIMEOUT_MS = 240_000;

const userQueue = new TelegramUserQueue();

const resolveChatTimeoutMs = (text: string, attachmentCount: number): number => {
  if (attachmentCount > 0 || /<file\s/i.test(text)) {
    return ATTACHMENT_CHAT_TIMEOUT_MS;
  }
  return OPENCLAW_CHAT_TIMEOUT_MS;
};

export const processContexts = async (contexts: Context[]): Promise<void> => {
  const primaryCtx = pickPrimaryContext(contexts);
  if (!primaryCtx) return;

  const telegramUserId = primaryCtx.from?.id;
  if (!telegramUserId) return;

  await userQueue.enqueue(telegramUserId, async () => {
    const user = getUserByTelegramId(telegramUserId);
    if (!user) {
      await primaryCtx.reply(LOGIN_REQUIRED_MESSAGE);
      return;
    }

    const parsedInput = await parseInputsFromContexts(contexts, config.telegram.token, telegramUserId).catch(
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
      logMessage(telegramUserId, 'incoming', parsedInput.text);
      touchUser(telegramUserId);

      const { ready } = await ensureUserContainer(user);
      if (!ready) {
        stopTypingOnce();
        await primaryCtx.reply('AI assistant is unavailable. Please retry later.');
        return;
      }

      textStream = createReplyStream(primaryCtx, stopTypingOnce);
      streamProgress = new TelegramStreamProgress();
      let runtimeUser = getUserByTelegramId(telegramUserId) ?? user;
      const timeoutMs = resolveChatTimeoutMs(parsedInput.text, parsedInput.attachments.length);
      let reply: OpenClawChatReply | null = null;
      let lastChatError: Error | null = null;

      for (let attempt = 0; attempt <= OPENCLAW_RETRY_LIMIT; attempt += 1) {
        const requestId = crypto.randomUUID();
        try {
          reply = await sendChatToOpenClaw(runtimeUser, {
            text: parsedInput.text,
            attachments: parsedInput.attachments,
            timeoutMs,
            idempotencyKey: requestId,
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
          dropOpenClawSession(telegramUserId);
          if (textStream) {
            await textStream.discard().catch(() => undefined);
          }

          const recovery = await ensureUserContainer(runtimeUser);
          if (!recovery.ready) {
            throw normalizedError;
          }
          runtimeUser = getUserByTelegramId(telegramUserId) ?? runtimeUser;

          textStream = createReplyStream(primaryCtx, stopTypingOnce);
          streamProgress = new TelegramStreamProgress();
        }
      }

      if (!reply) {
        throw lastChatError ?? new Error('OpenClaw response missing');
      }

      sanitizeUserCronStore(runtimeUser.telegram_user_id);
      logMessage(telegramUserId, 'outgoing', reply.text);

      stopTypingOnce();
      await finalizeStreamedReply(primaryCtx, runtimeUser, reply, textStream);
    } catch (error: unknown) {
      const normalizedError = toError(error);
      console.error('Message routing error', normalizedError);
      textStream?.stop();
      stopTypingOnce();
      dropOpenClawSession(telegramUserId);

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
        const runtimeUser = getUserByTelegramId(telegramUserId) ?? user;
        await restartUserContainer(runtimeUser);
        await primaryCtx.reply('Container restarted. Please retry your message.');
      } catch (restartError: unknown) {
        console.error('Container restart failed', restartError);
        await primaryCtx.reply('Restart failed. Please contact admin.');
      }
    }
  });
};
