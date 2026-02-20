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
const TOKEN_ALREADY_TAKEN_MESSAGE = [
  '🙈 Ohhh~ This token is already bound to another user!',
  'Please double-check and try again~'
].join('\n');

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
    '🐾 Welcome to PIN Claw Guide Bot~ ✨',
    '',
    "Let's set up your very own Telegram Assistant! It's super easy 💕",
    '🌸 Step 1 — Open @BotFather and send /newbot to create your new bot~',
    `🎀 Step 2 — Pick a cute username! Try something like: ${suggestedBotUsername} (BotFather has the final say though 🫣)`,
    '🍰 Step 3 — Got your token? Send it right here:',
    '/create_pin_claw_assistant <YOUR_BOT_TOKEN>',
    "🪄 Step 4 — Sit back and relax~ We'll set up your OpenClaw container in a blink ✧˖°",
    '',
    "🔐 Psst~ Your token is a secret! Keep it safe and don't share it with anyone 🤫"
  ].join('\n');

const assistantsListMessage = (assistants: AssistantRecord[]): string => {
  if (!assistants.length) {
    return "🧸 You haven't created any assistant bot yet~ Send /create_pin_claw_assistant <YOUR_BOT_TOKEN> to get started! 🌷";
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
  const normalized = candidate.replace(/\s+/g, '');
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(normalized)) return null;
  return normalized;
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
          "🫧 Oops~ The command format isn't quite right 🥺",
          'Please use it like this 👇🏻',
          '/create_pin_claw_assistant <YOUR_BOT_TOKEN>',
          '',
          '🍡 Example:',
          '/create_pin_claw_assistant 123456789:ABCDefghIJKLmnopQRSTuvwxYZ',
          '',
          'Try again~ You got this! 💪🏻✨'
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
      await ctx.reply(TOKEN_ALREADY_TAKEN_MESSAGE);
      return;
    }

    await ctx.reply('Verifying:\n🔍 Checking your bot token now~ Please wait a moment 🫧✨');

    try {
      const botIdentity = await validateAssistantBotToken(token);
      const assistant = ensureAssistantRecord(telegramUserId, botIdentity, token);
      const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(telegramUserId, assistant);
      const { ready } = await ensureAssistantContainer(assistantWithLiteLLM);
      await deleteAssistantBotWebhook(token);
      const latestAssistants = listAssistantsByOwnerTelegramId(telegramUserId);

      await ctx.reply(
        [
          `Success: https://t.me/${botIdentity.username}`,
          '🎉 Yay~ Binding successful! 💕',
          `Your bot @${botIdentity.username} is now connected to OpenClaw~ 🪄`,
          ...(config.litellm.enabled
            ? [
                assistantWithLiteLLM.litellm_key_alias
                  ? `🔐 LiteLLM key assigned: ${assistantWithLiteLLM.litellm_key_alias}`
                  : '🔐 LiteLLM dedicated key is enabled.'
              ]
            : []),
          ready
            ? '✅ Container is ready now~ You can chat with it right away! ✨'
            : '🐣 Container is starting up — usually ready in a few seconds! Hang tight~',
          `🧸 You currently have ${latestAssistants.length} assistant bot${latestAssistants.length === 1 ? '' : 's'}!`
        ].join('\n')
      );
    } catch (error: unknown) {
      console.error('Assistant bot setup failed', error);
      if (error instanceof Error && error.message === 'ASSISTANT_BOT_ALREADY_OWNED') {
        await ctx.reply(TOKEN_ALREADY_TAKEN_MESSAGE);
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
