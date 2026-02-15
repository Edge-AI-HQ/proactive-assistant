import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { createOauthSession, getUserByTelegramId } from '../db.js';
import { LOGIN_REQUIRED_MESSAGE } from './constants.js';

const commandList = [
  { command: 'start', description: 'Get Google login link' },
  { command: 'gateway', description: 'Get your Gateway URL' },
  { command: 'help', description: 'Show available commands' }
] as const;

const commandText = (): string => commandList.map((item) => `/${item.command} - ${item.description}`).join('\n');

const welcomeMessage = (loginUrl: string): string =>
  `Welcome to PIN AI Assistant.\n\nSign in with Google first:\n${loginUrl}`;

export const registerTelegramCommands = (bot: Bot<Context>): void => {
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
      await ctx.reply(LOGIN_REQUIRED_MESSAGE);
      return;
    }

    const url = `${config.publicBaseUrl}/gateway/${user.telegram_user_id}`;
    await ctx.reply(`Your Gateway URL:\n${url}`);
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });
};
