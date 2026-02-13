import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { MEDIA_GROUP_TIMEOUT_MS } from './constants.js';
import { registerTelegramCommands } from './commands.js';
import { registerTelegramCronDelivery } from './cron.js';
import { TelegramMediaGroupBuffer } from './mediaGroupBuffer.js';
import { processContexts } from './messageProcessor.js';
import { shouldSkipDuplicateUpdate } from './updateDedupe.js';

export const buildBot = (): Bot<Context> => {
  if (!config.telegram.token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(config.telegram.token);
  const mediaGroupBuffer = new TelegramMediaGroupBuffer(MEDIA_GROUP_TIMEOUT_MS, async (contexts) => {
    await processContexts(contexts);
  });

  registerTelegramCronDelivery(bot);
  registerTelegramCommands(bot);

  bot.on('message', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (shouldSkipDuplicateUpdate(ctx)) return;

    const rawText = typeof ctx.message?.text === 'string' ? ctx.message.text.trim() : '';
    if (rawText.startsWith('/')) return;

    const mediaGroupId = ctx.message?.media_group_id;
    if (typeof mediaGroupId === 'string' && mediaGroupId.trim()) {
      mediaGroupBuffer.add(mediaGroupId, ctx);
      return;
    }

    await processContexts([ctx]);
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
