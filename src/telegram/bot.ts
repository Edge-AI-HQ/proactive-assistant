import { Bot } from 'grammy';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { createOauthSession, getUserByTelegramId, logMessage, touchUser } from '../db.js';
import { ensureUserContainer, restartUserContainer } from '../docker/manager.js';
import { sendMessageToOpenClaw } from '../openclaw/client.js';

const welcomeMessage = (loginUrl: string): string =>
  `欢迎使用 PIN AI Assistant! 🦞\n我是一名 PIN AI personal assistant。\n\n请点击下方链接使用 Google 账号登录：\n${loginUrl}`;

const loginRequiredMessage = '请先完成登录：发送 /start 获取 Google 登录链接。';
const commandList = [
  { command: 'start', description: '获取 Google 登录链接' },
  { command: 'help', description: '查看可用命令' }
];

const commandText = (): string => commandList.map((item) => `/${item.command} - ${item.description}`).join('\n');

export const buildBot = (): Bot<Context> => {
  if (!config.telegram.token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN');
  }

  const bot = new Bot(config.telegram.token);

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
    await ctx.reply(`可用命令：\n${commandText()}`);
  });

  bot.hears(/^\s*[/／]\s*$/, async (ctx) => {
    await ctx.reply(`可用命令：\n${commandText()}`);
  });

  bot.on('message:text', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const user = getUserByTelegramId(telegramUserId);
    if (!user) {
      await ctx.reply(loginRequiredMessage);
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) return;

    let typingTimer: NodeJS.Timeout | undefined;

    const sendTyping = (): Promise<unknown> => ctx.replyWithChatAction('typing').catch(() => undefined);

    const startTyping = (): void => {
      void sendTyping();
      typingTimer = setInterval(() => {
        void sendTyping();
      }, 4000);
    };

    const stopTyping = (): void => {
      if (typingTimer) {
        clearInterval(typingTimer);
        typingTimer = undefined;
      }
    };

    try {
      logMessage(telegramUserId, 'incoming', text);
      touchUser(telegramUserId);

      startTyping();
      const { ready } = await ensureUserContainer(user);
      if (!ready) {
        stopTyping();
        await ctx.reply('AI助手暂时无响应，正在重试或请联系管理员 ❌');
        return;
      }

      const reply = await sendMessageToOpenClaw(user, text);
      logMessage(telegramUserId, 'outgoing', reply);
      stopTyping();
      await ctx.reply(reply);
    } catch (error: unknown) {
      console.error('Message routing error', error);
      stopTyping();
      await ctx.reply('AI助手暂时无响应，正在重启... 🔄');

      try {
        await restartUserContainer(user);
        await ctx.reply('系统已自动恢复 ✅');
      } catch (restartError: unknown) {
        console.error('Container restart failed', restartError);
        await ctx.reply('重启失败，请联系管理员 ❌');
      }
    }
  });

  bot.catch((err: unknown) => {
    console.error('Telegram bot error', err);
  });

  return bot;
};
