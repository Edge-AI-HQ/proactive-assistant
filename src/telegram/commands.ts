import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import { ensureUserContainer } from '../docker/manager.js';
import { ensureTelegramUser } from './identity.js';

const commandList = [
  { command: 'start', description: 'Initialize your assistant' },
  { command: 'gateway', description: 'Open your Gateway' },
  { command: 'help', description: 'Show available commands' }
] as const;

const commandText = (): string => commandList.map((item) => `/${item.command} - ${item.description}`).join('\n');

const welcomeMessage = (): string =>
  'Welcome to PIN AI Assistant.\n\nYour Telegram ID is now your global user ID. You can start chatting right away.';

const isHttpsPublicBaseUrl = (): boolean => {
  try {
    return new URL(config.publicBaseUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

export const registerTelegramCommands = (bot: Bot<Context>): void => {
  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error('Failed to set bot commands', error);
  });

  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const telegramUsername = ctx.from?.username ?? null;
    const user = ensureTelegramUser(telegramUserId, telegramUsername);
    await ctx.reply(welcomeMessage());
    await ctx.reply('Preparing your dedicated assistant container...');

    try {
      const { ready } = await ensureUserContainer(user);
      if (ready) {
        await ctx.reply('Your assistant is ready. Send me any message to start.');
      } else {
        await ctx.reply('Container startup is in progress. Please retry in a moment.');
      }
    } catch (error: unknown) {
      console.error('Container init from /start failed', error);
      await ctx.reply('Container startup failed. Please contact admin.');
    }
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });

  bot.command('gateway', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const user = ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const gatewayPath = `/gateway/${user.telegram_user_id}`;
    const supportsLoginUrl = isHttpsPublicBaseUrl();
    const keyboard = new InlineKeyboard();
    if (supportsLoginUrl) {
      const callbackUrl = new URL('/auth/telegram/callback', config.publicBaseUrl);
      callbackUrl.searchParams.set('user_id', String(user.telegram_user_id));
      callbackUrl.searchParams.set('next', gatewayPath);
      keyboard.login('Open Gateway', {
        url: callbackUrl.toString(),
        request_write_access: true
      });
    } else {
      const url = `${config.publicBaseUrl}${gatewayPath}`;
      keyboard.url('Open Gateway', url);
    }

    await ctx.reply(
      supportsLoginUrl
        ? 'Open your personal Gateway dashboard.'
        : 'Open your personal Gateway dashboard. For one-tap Telegram login, set PUBLIC_BASE_URL to an HTTPS URL.',
      {
        reply_markup: keyboard
      }
    );
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });
};
