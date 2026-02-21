import { Bot, InlineKeyboard, type Context } from 'grammy';
import { config } from '../config.js';
import {
  createAssistant,
  createGatewaySession,
  getAssistantByBotId,
  getAssistantByBotToken,
  listAssistantsByOwnerTelegramId,
  updateAssistant
} from '../db.js';
import { allocatePort, containerNameForAssistant, ensureAssistantContainer } from '../modules/container/manager.js';
import { ensureLiteLLMKeyForAssistant } from '../modules/litellm/service.js';
import { createPaymentSessionForUser, isPaymentGatewayEnabled } from '../modules/payment/client.js';
import { ensureTelegramUser } from './identity.js';
import type { AssistantRecord } from '../types.js';

const commandList = [
  { command: 'start', description: 'Start onboarding to create your own assistant bot' },
  { command: 'create_pin_claw_assistant', description: 'Bind your BotFather token and provision assistant' },
  { command: 'list_pin_claw_assistants', description: 'Show all assistant bots you created' },
  { command: 'gateway', description: 'Open OpenClaw dashboard for one of your bots' },
  { command: 'payment_link', description: 'Generate subscription payment link' },
  { command: 'help', description: 'Show available commands' }
] as const;

const BOT_USERNAME_SUFFIX = '_PIN_Claw_Bot';
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const GATEWAY_LINK_SESSION_TTL_HOURS = 12;
const DEFAULT_NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_TUNNEL_CACHE_MS = 30_000;
const TOKEN_ALREADY_TAKEN_MESSAGE = [
  '🙈 Ohhh~ This token is already bound to another user!',
  'Please double-check and try again~'
].join('\n');

let ngrokOriginCache: { expiresAt: number; value: URL | null } = {
  expiresAt: 0,
  value: null
};

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

const ensureAssistantRecord = async (
  ownerTelegramUserId: number,
  botIdentity: AssistantBotIdentity,
  token: string
): Promise<AssistantRecord> => {
  const defaultContainerName = containerNameForAssistant(botIdentity.botId);
  const existingByBotId = await getAssistantByBotId(botIdentity.botId);
  if (existingByBotId) {
    if (existingByBotId.owner_telegram_user_id !== ownerTelegramUserId) {
      throw new Error('ASSISTANT_BOT_ALREADY_OWNED');
    }
    return (
      (await updateAssistant(existingByBotId.id, {
        assistant_bot_token: token,
        assistant_bot_username: botIdentity.username,
        container_name: existingByBotId.container_name?.trim() || defaultContainerName
      })) ?? existingByBotId
    );
  }

  const created = await createAssistant({
    owner_telegram_user_id: ownerTelegramUserId,
    assistant_bot_id: botIdentity.botId,
    assistant_bot_token: token,
    assistant_bot_username: botIdentity.username,
    container_name: defaultContainerName,
    container_id: defaultContainerName,
    container_port: await allocatePort(),
    container_status: 'creating'
  });

  if (!created) {
    throw new Error(`Failed to create assistant for bot ${botIdentity.botId}`);
  }

  return created;
};

const safeCreatePaymentLink = async (telegramUserId: number, telegramUsername: string | null): Promise<string | null> => {
  if (!isPaymentGatewayEnabled()) return null;
  try {
    const session = await createPaymentSessionForUser(telegramUserId, telegramUsername);
    return session?.subscribe_url ?? null;
  } catch (error: unknown) {
    console.error('Failed to create payment link', {
      telegramUserId,
      error: error instanceof Error ? error.message : String(error || '')
    });
    return null;
  }
};

const resolvePublicOrigin = (): URL | null => {
  try {
    return new URL(config.publicBaseUrl);
  } catch {
    return null;
  }
};

const isLocalhostHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
};

const isTelegramInlineUrlAllowed = (url: URL): boolean => {
  if (url.protocol !== 'https:') return false;
  if (!url.hostname.trim()) return false;
  if (isLocalhostHost(url.hostname)) return false;
  return true;
};

const toOriginUrl = (url: URL): URL => new URL(url.origin);

const resolveNgrokPublicOriginFromEnv = (): URL | null => {
  const candidates = [process.env.NGROK_PUBLIC_URL, process.env.NGROK_URL, process.env.NGROK_TUNNEL_URL];
  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    try {
      const parsed = new URL(raw);
      if (isTelegramInlineUrlAllowed(parsed)) {
        return toOriginUrl(parsed);
      }
    } catch {
      // ignore invalid candidate and continue
    }
  }
  return null;
};

const resolveNgrokPublicOriginFromApi = async (): Promise<URL | null> => {
  const now = Date.now();
  if (ngrokOriginCache.expiresAt > now) {
    return ngrokOriginCache.value;
  }

  let resolved: URL | null = null;
  const apiUrl = process.env.NGROK_API_URL?.trim() || DEFAULT_NGROK_API_URL;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1500)
    });
    if (response.ok) {
      const payload = (await response.json()) as {
        tunnels?: Array<{ public_url?: string; proto?: string }>;
      };
      for (const tunnel of payload.tunnels || []) {
        if (tunnel.proto !== 'https' || !tunnel.public_url) continue;
        try {
          const parsed = new URL(tunnel.public_url);
          if (!isTelegramInlineUrlAllowed(parsed)) continue;
          resolved = toOriginUrl(parsed);
          break;
        } catch {
          // ignore malformed tunnel url
        }
      }
    }
  } catch {
    // ngrok api may be unavailable in non-dev environments
  }

  ngrokOriginCache = {
    expiresAt: now + NGROK_TUNNEL_CACHE_MS,
    value: resolved
  };
  return resolved;
};

const resolveGatewayPublicOrigin = async (): Promise<URL | null> => {
  const configured = resolvePublicOrigin();
  if (configured && isTelegramInlineUrlAllowed(configured)) {
    return toOriginUrl(configured);
  }

  const ngrokFromEnv = resolveNgrokPublicOriginFromEnv();
  if (ngrokFromEnv) {
    return ngrokFromEnv;
  }

  const ngrokFromApi = await resolveNgrokPublicOriginFromApi();
  if (ngrokFromApi) {
    return ngrokFromApi;
  }

  return null;
};

const buildAssistantGatewayUrl = (
  publicOrigin: string,
  telegramUserId: number,
  assistantId: number,
  sessionToken?: string
): string => {
  const url = new URL(`/gateway/${telegramUserId}/bot/${assistantId}`, publicOrigin);
  if (sessionToken) {
    url.searchParams.set('gateway_sid', sessionToken);
  }
  return url.toString();
};

const buildAssistantGatewayLinksText = (
  assistants: AssistantRecord[],
  publicOrigin: string,
  telegramUserId: number,
  sessionToken?: string
): string => {
  return assistants
    .map(
      (assistant, index) =>
        `${index + 1}. @${assistant.assistant_bot_username} (${assistant.container_status || 'unknown'})\n${buildAssistantGatewayUrl(publicOrigin, telegramUserId, assistant.id, sessionToken)}`
    )
    .join('\n\n');
};

export const registerTelegramCommands = (bot: Bot<Context>): void => {
  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error('Failed to set bot commands', error);
  });

  bot.command('start', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    const telegramUsername = ctx.from?.username ?? null;
    await ensureTelegramUser(telegramUserId, telegramUsername);
    const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);
    const paymentLink = await safeCreatePaymentLink(telegramUserId, telegramUsername);

    const sections = [welcomeMessage(suggestBotUsername(ctx)), '', assistantsListMessage(assistants)];
    if (paymentLink) {
      sections.push('', `💳 Payment subscription link: ${paymentLink}`);
    }

    await ctx.reply(sections.join('\n'));
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

    await ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const existingOwner = await getAssistantByBotToken(token);
    if (existingOwner && existingOwner.owner_telegram_user_id !== telegramUserId) {
      await ctx.reply(TOKEN_ALREADY_TAKEN_MESSAGE);
      return;
    }

    await ctx.reply('Verifying:\n🔍 Checking your bot token now~ Please wait a moment 🫧✨');

    try {
      const botIdentity = await validateAssistantBotToken(token);
      const assistant = await ensureAssistantRecord(telegramUserId, botIdentity, token);
      const assistantWithLiteLLM = await ensureLiteLLMKeyForAssistant(telegramUserId, assistant);
      const { ready } = await ensureAssistantContainer(assistantWithLiteLLM);
      await deleteAssistantBotWebhook(token);
      const latestAssistants = await listAssistantsByOwnerTelegramId(telegramUserId);

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
      if (error instanceof Error) {
        const message = error.message.toLowerCase();
        const looksLikeLiteLLMFailure =
          message.includes('litellm') ||
          message.includes('econnrefused') ||
          (message.includes('connect') && message.includes(':4000'));
        if (looksLikeLiteLLMFailure) {
          await ctx.reply(
            `LiteLLM 连接或配置失败（${config.litellm.baseUrl}）。请先确认 LiteLLM 服务已启动且 LITELLM_MASTER_KEY 已正确配置。`
          );
          return;
        }
      }
      await ctx.reply('创建失败。请确认 token 正确、bot 可用，并稍后重试。');
    }
  });

  bot.command('list_pin_claw_assistants', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);
    await ctx.reply(assistantsListMessage(assistants));
  });

  bot.command('gateway', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUser(telegramUserId, ctx.from?.username ?? null);
    const assistants = await listAssistantsByOwnerTelegramId(telegramUserId);

    if (!assistants.length) {
      await ctx.reply('你还没有可用的 assistant bot。请先使用 /create_pin_claw_assistant 创建。');
      return;
    }

    const publicBase = await resolveGatewayPublicOrigin();
    if (!publicBase) {
      await ctx.reply(
        [
          '未检测到可用的公网 HTTPS 地址，暂时无法生成 Gateway 按钮。',
          '请配置 PUBLIC_BASE_URL 或 NGROK_PUBLIC_URL 为你的 ngrok HTTPS 域名后重试。'
        ].join('\n')
      );
      return;
    }

    const publicOrigin = publicBase.origin;
    let sessionToken: string | null = null;
    try {
      const session = await createGatewaySession(telegramUserId, GATEWAY_LINK_SESSION_TTL_HOURS);
      sessionToken = session.sessionToken;
    } catch (error: unknown) {
      console.error('Failed to create gateway session for command', {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error || '')
      });
      await ctx.reply('Gateway 登录会话创建失败，请稍后重试。');
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const assistant of assistants) {
      const buttonLabel = `@${assistant.assistant_bot_username} (${assistant.container_status || 'unknown'})`;
      const url = buildAssistantGatewayUrl(publicOrigin, telegramUserId, assistant.id, sessionToken);
      keyboard.url(buttonLabel, url).row();
    }

    try {
      await ctx.reply('请选择要打开的 bot：', {
        reply_markup: keyboard
      });
    } catch (error: unknown) {
      console.error('Failed to send gateway inline keyboard', {
        telegramUserId,
        publicOrigin,
        error: error instanceof Error ? error.message : String(error || '')
      });

      const links = buildAssistantGatewayLinksText(assistants, publicOrigin, telegramUserId, sessionToken);
      await ctx.reply(
        [
          'Gateway 按钮发送失败，已回退为纯文本链接。',
          `当前 Gateway 地址=${publicOrigin}`,
          '',
          links
        ].join('\n')
      );
    }
  });

  bot.command('payment_link', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    const telegramUsername = ctx.from?.username ?? null;
    await ensureTelegramUser(telegramUserId, telegramUsername);

    if (!isPaymentGatewayEnabled()) {
      await ctx.reply('Payment gateway is not configured yet. Please contact the admin.');
      return;
    }

    const paymentLink = await safeCreatePaymentLink(telegramUserId, telegramUsername);
    if (!paymentLink) {
      await ctx.reply('Failed to create payment link. Please try again in a moment.');
      return;
    }

    await ctx.reply(`💳 Your payment link:\n${paymentLink}`);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await ctx.reply(`Available commands:\n${commandText()}`);
  });
};
