import type { Context } from 'grammy';
import type { OpenClawChatReply } from '../openclaw/chatSessionService.js';
import { deliverOpenClawReply } from './delivery.js';
import { MAX_TEXT_CHUNK, TELEGRAM_STREAM_THROTTLE_MS } from './constants.js';
import { createTelegramTextStream } from './stream.js';
import { stripMediaDirectivesFromText } from './text.js';

export interface TelegramReplyUser {
  telegram_user_id: number;
  container_port: number;
  container_id: string;
}

export const createReplyStream = (
  ctx: Context,
  stopTypingOnce: () => void
): ReturnType<typeof createTelegramTextStream> => {
  return createTelegramTextStream({
    ctx,
    throttleMs: TELEGRAM_STREAM_THROTTLE_MS,
    maxChars: MAX_TEXT_CHUNK,
    onFirstRender: stopTypingOnce,
    onWarn: (message) => {
      console.warn(message);
    }
  });
};

export const finalizeStreamedReply = async (
  ctx: Context,
  user: TelegramReplyUser,
  reply: OpenClawChatReply,
  textStream: ReturnType<typeof createTelegramTextStream>
): Promise<void> => {
  let streamResult: Awaited<ReturnType<typeof textStream.finalize>>;
  try {
    streamResult = await textStream.finalize(stripMediaDirectivesFromText(reply.text));
  } catch (error: unknown) {
    console.warn('Telegram stream finalize failed', error);
    textStream.stop();
    await deliverOpenClawReply(ctx, user, reply);
    return;
  }

  if (streamResult.overflowed) {
    await textStream.discard().catch(() => undefined);
    await deliverOpenClawReply(ctx, user, reply);
    return;
  }

  if (streamResult.streamed) {
    await deliverOpenClawReply(ctx, user, reply, {
      skipText: true,
      suppressEmptyFallback: true
    });
    return;
  }

  await deliverOpenClawReply(ctx, user, reply);
};
