import { Bot, type Context } from 'grammy';
import { config } from '../common/config.js';
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
    await ctx.reply('Send /start to get started, or /create_claw_assistant to set up your AI assistant.', {
      parse_mode: 'HTML'
    });
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
