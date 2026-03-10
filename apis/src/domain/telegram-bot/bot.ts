import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../common/config.js';
import { buildGuideBotStartWelcome, registerTelegramCommands } from './commands.js';
import { shouldSkipDuplicateUpdate } from './updateDedupe.js';

export const buildGuideBotFallbackMessage = (): {
  text: string;
  buttonText: string;
  miniAppUrl: string;
} => {
  const { buttonText, miniAppUrl } = buildGuideBotStartWelcome();

  return {
    text: 'Please click the Mini App button to experience PIN Claw.',
    buttonText,
    miniAppUrl,
  };
};

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
    const payload = buildGuideBotFallbackMessage();
    const keyboard = new InlineKeyboard().webApp(
      payload.buttonText,
      payload.miniAppUrl,
    );

    await ctx.reply(payload.text, {
      reply_markup: keyboard,
    });
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
