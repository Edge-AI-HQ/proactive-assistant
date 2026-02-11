import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import {
  createOauthSession,
  getUserByTelegramId,
  logMessage,
  touchUser
} from '../db.js';
import { ensureUserContainer, restartUserContainer, sanitizeUserCronStore } from '../docker/manager.js';
import {
  dropOpenClawSession,
  sendChatToOpenClaw,
  setOpenClawCronEventHandler,
  type OpenClawCronFinishedEvent
} from '../openclaw/client.js';
import { renderTelegramHtmlFromMarkdown } from './format.js';
import { type ParsedTelegramInput, parseTelegramInput } from './input.js';
import { deliverOpenClawReply } from './delivery.js';
import { createTelegramTextStream } from './stream.js';

const loginRequiredMessage = 'Please login first. Send /start to get the Google login link.';
const MEDIA_GROUP_TIMEOUT_MS = 500;
const TELEGRAM_PARSE_ERROR_RE = /can't parse entities|parse entities|find end of the entity/i;
const MAX_TEXT_CHUNK = 3900;
const TELEGRAM_STREAM_THROTTLE_MS = 800;

type QueuedTask = () => Promise<void>;

type MediaGroupEntry = {
  contexts: Context[];
  timer: NodeJS.Timeout;
};

const userQueues = new Map<number, Promise<void>>();
const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

const commandList = [
  { command: 'start', description: 'Get Google login link' },
  { command: 'gateway', description: 'Get your Gateway URL' },
  { command: 'help', description: 'Show available commands' }
] as const;

const commandText = (): string => commandList.map((item) => `/${item.command} - ${item.description}`).join('\n');

const welcomeMessage = (loginUrl: string): string =>
  `Welcome to PIN AI Assistant.\n\nSign in with Google first:\n${loginUrl}`;

const chunkText = (text: string): string[] => {
  if (text.length <= MAX_TEXT_CHUNK) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let next = Math.min(cursor + MAX_TEXT_CHUNK, text.length);
    if (next < text.length) {
      const newline = text.lastIndexOf('\n', next);
      if (newline > cursor + 800) {
        next = newline;
      }
    }
    chunks.push(text.slice(cursor, next).trim());
    cursor = next;
  }

  return chunks.filter(Boolean);
};

const sendBotText = async (bot: Bot<Context>, chatId: number, text: string): Promise<void> => {
  const html = renderTelegramHtmlFromMarkdown(text);
  try {
    await bot.api.sendMessage(chatId, html, {
      parse_mode: 'HTML'
    });
    return;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!TELEGRAM_PARSE_ERROR_RE.test(message)) {
      throw error;
    }
  }
  await bot.api.sendMessage(chatId, text);
};

const formatCronMessage = (event: OpenClawCronFinishedEvent): string => {
  const summary = event.summary?.trim();
  if (summary) return summary;
  if (event.status === 'error' && typeof event.error === 'string' && event.error.trim()) {
    return `Cron job failed: ${event.error.trim()}`;
  }
  return '';
};

const enqueueByUser = async (telegramUserId: number, task: QueuedTask): Promise<void> => {
  const current = userQueues.get(telegramUserId) ?? Promise.resolve();
  const next = current.catch(() => undefined).then(task);
  userQueues.set(telegramUserId, next);

  try {
    await next;
  } finally {
    if (userQueues.get(telegramUserId) === next) {
      userQueues.delete(telegramUserId);
    }
  }
};

const mergeParsedInputs = (parsedInputs: ParsedTelegramInput[]): ParsedTelegramInput | null => {
  if (parsedInputs.length === 0) return null;

  const textParts = parsedInputs.map((item) => item.text.trim()).filter(Boolean);
  const attachments = parsedInputs.flatMap((item) => item.attachments);
  const text = textParts.join('\n').trim() || 'Please process these attachments.';

  return {
    text,
    attachments
  };
};

const parseInputsFromContexts = async (
  contexts: Context[],
  botToken: string,
  telegramUserId: number
): Promise<ParsedTelegramInput | null> => {
  const parsedInputs: ParsedTelegramInput[] = [];

  for (const ctx of contexts) {
    const parsed = await parseTelegramInput(ctx, botToken, telegramUserId);
    if (parsed) parsedInputs.push(parsed);
  }

  return mergeParsedInputs(parsedInputs);
};

const startTypingLoop = (ctx: Context): (() => void) => {
  let typingTimer: NodeJS.Timeout | null = null;

  const sendTyping = (): Promise<unknown> => ctx.replyWithChatAction('typing').catch(() => undefined);
  void sendTyping();
  typingTimer = setInterval(() => {
    void sendTyping();
  }, 4000);

  return () => {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = null;
  };
};

const pickPrimaryContext = (contexts: Context[]): Context | null => {
  if (contexts.length === 0) return null;

  const withText = contexts.find((ctx) => {
    const text = typeof ctx.message?.text === 'string' ? ctx.message.text : '';
    const caption = typeof ctx.message?.caption === 'string' ? ctx.message.caption : '';
    return Boolean(text.trim() || caption.trim());
  });

  return withText ?? contexts[0] ?? null;
};

const processContexts = async (contexts: Context[]): Promise<void> => {
  const primaryCtx = pickPrimaryContext(contexts);
  if (!primaryCtx) return;

  const telegramUserId = primaryCtx.from?.id;
  if (!telegramUserId) return;

  await enqueueByUser(telegramUserId, async () => {
    const user = getUserByTelegramId(telegramUserId);
    if (!user) {
      await primaryCtx.reply(loginRequiredMessage);
      return;
    }

    let parsedInput: ParsedTelegramInput | null = null;
    try {
      parsedInput = await parseInputsFromContexts(contexts, config.telegram.token, telegramUserId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to parse Telegram input.';
      await primaryCtx.reply(message);
      return;
    }

    if (!parsedInput) return;

    const stopTyping = startTypingLoop(primaryCtx);
    let typingStopped = false;
    const stopTypingOnce = (): void => {
      if (typingStopped) return;
      typingStopped = true;
      stopTyping();
    };
    let textStream: ReturnType<typeof createTelegramTextStream> | null = null;

    try {
      logMessage(telegramUserId, 'incoming', parsedInput.text);
      touchUser(telegramUserId);

      const { ready } = await ensureUserContainer(user);
      if (!ready) {
        stopTypingOnce();
        await primaryCtx.reply('AI assistant is unavailable. Please retry later.');
        return;
      }

      textStream = createTelegramTextStream({
        ctx: primaryCtx,
        throttleMs: TELEGRAM_STREAM_THROTTLE_MS,
        maxChars: MAX_TEXT_CHUNK,
        onFirstRender: stopTypingOnce,
        onWarn: (message) => {
          console.warn(message);
        }
      });

      const reply = await sendChatToOpenClaw(user, {
        text: parsedInput.text,
        attachments: parsedInput.attachments,
        onDelta: (text) => {
          textStream?.update(text);
        }
      });
      sanitizeUserCronStore(user.telegram_user_id);
      logMessage(telegramUserId, 'outgoing', reply.text);

      const streamResult = await textStream.finalize(reply.text);
      stopTypingOnce();

      if (streamResult.overflowed) {
        await textStream.discard().catch(() => undefined);
        await deliverOpenClawReply(primaryCtx, user, reply);
        return;
      }

      if (streamResult.streamed) {
        await deliverOpenClawReply(primaryCtx, user, reply, {
          skipText: true,
          suppressEmptyFallback: true
        });
        return;
      }

      await deliverOpenClawReply(primaryCtx, user, reply);
    } catch (error: unknown) {
      console.error('Message routing error', error);
      textStream?.stop();
      stopTypingOnce();
      await primaryCtx.reply('Assistant unavailable. Restarting your container...');

      try {
        dropOpenClawSession(telegramUserId);
        await restartUserContainer(user);
        await primaryCtx.reply('Container restarted. Please retry your message.');
      } catch (restartError: unknown) {
        console.error('Container restart failed', restartError);
        await primaryCtx.reply('Restart failed. Please contact admin.');
      }
    }
  });
};

const flushMediaGroup = async (mediaGroupId: string): Promise<void> => {
  const entry = mediaGroupBuffer.get(mediaGroupId);
  if (!entry) return;

  mediaGroupBuffer.delete(mediaGroupId);
  clearTimeout(entry.timer);

  await processContexts(entry.contexts);
};

const bufferMediaGroup = (mediaGroupId: string, ctx: Context): void => {
  const existing = mediaGroupBuffer.get(mediaGroupId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.contexts.push(ctx);
    existing.timer = setTimeout(() => {
      void flushMediaGroup(mediaGroupId);
    }, MEDIA_GROUP_TIMEOUT_MS);
    return;
  }

  const timer = setTimeout(() => {
    void flushMediaGroup(mediaGroupId);
  }, MEDIA_GROUP_TIMEOUT_MS);
  mediaGroupBuffer.set(mediaGroupId, {
    contexts: [ctx],
    timer
  });
};

export const buildBot = (): Bot<Context> => {
  if (!config.telegram.token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(config.telegram.token);

  setOpenClawCronEventHandler(async (event) => {
    const message = formatCronMessage(event);
    if (!message) return;

    const chunks = chunkText(message);
    for (const chunk of chunks) {
      try {
        await sendBotText(bot, event.telegramUserId, chunk);
      } catch (error: unknown) {
        console.error('Cron Telegram delivery failed', error);
        break;
      }
    }
  });

  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error('Failed to set bot commands', error);
  });

  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const telegramUsername = ctx.from?.username;
    const { stateToken } = createOauthSession(telegramUserId, telegramUsername);
    const loginUrl = `${config.publicBaseUrl}/auth/google?state=${stateToken}`;
    await ctx.reply(welcomeMessage(loginUrl));
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });

  bot.command('gateway', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const user = getUserByTelegramId(telegramUserId);
    if (!user) {
      await ctx.reply(loginRequiredMessage);
      return;
    }

    const url = `${config.publicBaseUrl}/gateway/${user.telegram_user_id}?token=${user.gateway_token}`;
    await ctx.reply(`Your Gateway URL:\n${url}`);
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });

  bot.on('message', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const rawText = typeof ctx.message?.text === 'string' ? ctx.message.text.trim() : '';
    if (rawText.startsWith('/')) return;

    const mediaGroupId = ctx.message?.media_group_id;
    if (typeof mediaGroupId === 'string' && mediaGroupId.trim()) {
      bufferMediaGroup(mediaGroupId, ctx);
      return;
    }

    await processContexts([ctx]);
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
