import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { registerTelegramCommands } from './commands.js';
import { shouldSkipDuplicateUpdate } from './updateDedupe.js';

export const buildBot = (): Bot<Context> => {
  if (!config.telegram.token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(config.telegram.token);

  registerTelegramCommands(bot);

  bot.on('message', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    if (shouldSkipDuplicateUpdate(ctx, 'guide')) return;

    const rawText = typeof ctx.message?.text === 'string' ? ctx.message.text.trim() : '';
    if (rawText.startsWith('/')) return;
    await ctx.reply('<b>This bot is for assistant onboarding only.</b>\nPlease send /start first.', {
      parse_mode: 'HTML'
    });
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
