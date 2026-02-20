import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import {
  createAssistant,
  getAssistantByBotId,
  getAssistantByBotToken,
  listAssistantsByOwnerTelegramId,
  updateAssistant
} from '../db.js';
import { allocatePort, containerNameForAssistant, ensureAssistantContainer } from '../docker/manager.js';
import { ensureLiteLLMKeyForAssistant } from '../litellm/service.js';
import { ensureTelegramUser } from './identity.js';
import type { AssistantRecord } from '../types.js';

const commandList = [
  { command: 'start', description: 'Start onboarding to create your own assistant bot' },
  { command: 'create_pin_claw_assistant', description: 'Bind your BotFather token and provision assistant' },
  { command: 'list_pin_claw_assistants', description: 'Show all assistant bots you created' },
  { command: 'help', description: 'Show available commands' }
] as const;

const BOT_USERNAME_SUFFIX = '_PIN_Claw_Bot';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const commandText = (): string => commandList.map((item) => `/${item.command} - ${item.description}`).join('\n');

const normalizeBotUsernameBase = (value: string): string => value.replace(/[^a-zA-Z0-9_]/g, '');

const suggestBotUsername = (ctx: Context): string => {
  const maxLength = 32;
  const baseMax = Math.max(1, maxLength - BOT_USERNAME_SUFFIX.length);
  const source =
    normalizeBotUsernameBase(ctx.from?.username || '') ||
    normalizeBotUsernameBase(ctx.from?.first_name || '') ||
    `User${ctx.from?.id ?? ''}`;
  const base = source.slice(0, baseMax) || 'User';
  return `${base}${BOT_USERNAME_SUFFIX}`;
};

const welcomeMessage = (suggestedBotUsername: string): string =>
  [
    '欢迎使用 PIN Claw 引导 Bot。',
    '',
    '请按以下流程创建你自己的 Telegram Assistant Bot：',
    '1) 打开 @BotFather，发送 /newbot 创建新 bot。',
    `2) 可参考用户名：${suggestedBotUsername}（最终以 BotFather 校验为准）。`,
    '3) 获得 token 后，在这里发送：',
    '/create_pin_claw_assistant <YOUR_BOT_TOKEN>',
    '4) 后端会创建并绑定你的 OpenClaw container。',
    '',
    '提示：token 是敏感信息，请勿分享给他人。'
  ].join('\n');

const assistantsListMessage = (assistants: AssistantRecord[]): string => {
  if (!assistants.length) {
    return '你还没有创建任何 assistant bot。发送 /create_pin_claw_assistant <YOUR_BOT_TOKEN> 开始创建。';
  }

  const lines = assistants.map((assistant, index) => {
    const username = assistant.assistant_bot_username;
    return `${index + 1}. @${username} | status: ${assistant.container_status} | https://t.me/${username}`;
  });
  return ['你创建的 assistant bot：', ...lines].join('\n');
};

const parseAssistantToken = (text: string | undefined): string | null => {
  if (!text) return null;
  const trimmed = text.trim();
  const withoutCommand = trimmed.replace(/^\/create_pin_claw_assistant(?:@\w+)?/i, '').trim();
  if (!withoutCommand) return null;
  const candidate = withoutCommand.replace(/^token(?:_id)?\s*[:=]\s*/i, '').trim();
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(candidate)) return null;
  return candidate;
};

interface AssistantBotIdentity {
  botId: number;
  username: string;
}

const validateAssistantBotToken = async (token: string): Promise<AssistantBotIdentity> => {
  const candidate = new Bot(token);
  await candidate.init();
  const botId = candidate.botInfo?.id;
  const username = candidate.botInfo?.username?.trim();
  if (!botId || !username) {
    throw new Error('Token is valid but bot metadata is missing.');
  }
  return { botId, username };
};

const deleteAssistantBotWebhook = async (token: string): Promise<void> => {
  const candidate = new Bot(token);
  await candidate.api.deleteWebhook({ drop_pending_updates: true });
};

const ensureAssistantRecord = (
  ownerTelegramUserId: number,
  botIdentity: AssistantBotIdentity,
  token: string
): AssistantRecord => {
  const defaultContainerName = containerNameForAssistant(botIdentity.botId);
  const existingByBotId = getAssistantByBotId(botIdentity.botId);
  if (existingByBotId) {
    if (existingByBotId.owner_telegram_user_id !== ownerTelegramUserId) {
      throw new Error('ASSISTANT_BOT_ALREADY_OWNED');
    }
    return (
      updateAssistant(existingByBotId.id, {
        assistant_bot_token: token,
        assistant_bot_username: botIdentity.username,
        container_name: existingByBotId.container_name?.trim() || defaultContainerName
      }) ?? existingByBotId
    );
  }

  const created = createAssistant({
    owner_telegram_user_id: ownerTelegramUserId,
    assistant_bot_id: botIdentity.botId,
    assistant_bot_token: token,
    assistant_bot_username: botIdentity.username,
    container_name: defaultContainerName,
    container_id: defaultContainerName,
    container_port: allocatePort(),
    container_status: 'creating'
  });

  if (!created) {
    throw new Error(`Failed to create assistant for bot ${botIdentity.botId}`);
  }

  return created;
};

export const registerTelegramCommands = (bot: Bot<Context>): void => {
  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error('Failed to set bot commands', error);
  });

  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const assistants = listAssistantsByOwnerTelegramId(telegramUserId);

    await ctx.reply([welcomeMessage(suggestBotUsername(ctx)), '', assistantsListMessage(assistants)].join('\n'));
  });

  bot.command('create_pin_claw_assistant', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const token = parseAssistantToken(ctx.message?.text);
    if (!token) {
      await ctx.reply(
        [
          '命令格式不正确，请使用：',
          '/create_pin_claw_assistant <YOUR_BOT_TOKEN>',
          '',
          '示例：',
          '/create_pin_claw_assistant 123456789:ABCDefghIJKLmnopQRSTuvwxYZ'
        ].join('\n')
      );
      return;
    }

    if (token === config.telegram.token) {
      await ctx.reply('该 token 是引导 bot 自身 token。请使用你在 BotFather 新建 bot 的 token。');
      return;
    }

    ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const existingOwner = getAssistantByBotToken(token);
    if (existingOwner && existingOwner.owner_telegram_user_id !== telegramUserId) {
      await ctx.reply('这个 token 已绑定到其他用户，请确认后再试。');
      return;
    }

    await ctx.reply('正在校验 bot token，并准备创建 OpenClaw container，请稍候...');

    try {
      const botIdentity = await validateAssistantBotToken(token);
      const assistant = ensureAssistantRecord(telegramUserId, botIdentity, token);
      const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(telegramUserId, assistant);
      const { ready } = await ensureAssistantContainer(assistantWithLiteLLM);
      await deleteAssistantBotWebhook(token);
      const latestAssistants = listAssistantsByOwnerTelegramId(telegramUserId);

      await ctx.reply(
        [
          `绑定成功：@${botIdentity.username}`,
          `你的 bot 已直连 OpenClaw container：https://t.me/${botIdentity.username}`,
          ...(config.litellm.enabled
            ? [
                assistantWithLiteLLM.litellm_key_alias
                  ? `已分配独立 LiteLLM key：${assistantWithLiteLLM.litellm_key_alias}`
                  : '已启用独立 LiteLLM key。'
              ]
            : []),
          ready ? 'Container 已就绪。' : 'Container 正在启动中，通常几十秒后可用。',
          `你当前共有 ${latestAssistants.length} 个 assistant bot。`
        ].join('\n')
      );
    } catch (error: unknown) {
      console.error('Assistant bot setup failed', error);
      if (error instanceof Error && error.message === 'ASSISTANT_BOT_ALREADY_OWNED') {
        await ctx.reply('这个 bot 已绑定到其他用户，请使用你自己的 bot token。');
        return;
      }
      if (error instanceof Error && error.message.includes('Fly runtime assistant provisioning is not supported')) {
        await ctx.reply('当前部署模式暂不支持自动创建 assistant container，请联系管理员切换到 Docker runtime。');
        return;
      }
      if (error instanceof Error && error.message.toLowerCase().includes('litellm')) {
        await ctx.reply('LiteLLM key 分配失败，请稍后重试或联系管理员检查 LiteLLM 服务。');
        return;
      }
      await ctx.reply('创建失败。请确认 token 正确、bot 可用，并稍后重试。');
    }
  });

  bot.command('list_pin_claw_assistants', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const assistants = listAssistantsByOwnerTelegramId(telegramUserId);
    await ctx.reply(assistantsListMessage(assistants));
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });
};
