import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../common/config.js";
import {
  BackendApiError,
  createGatewaySessionViaApi,
  createPaymentSessionForUser,
  createAssistantWithoutContainerViaApi,
  cancelUserSubscription,
  deleteAssistantViaApi,
  ensureTelegramUserViaApi,
  isPaymentEnabled,
  listAssistantsByOwnerViaApi,
  provisionAssistantViaApi,
} from "./client.js";
import type { AssistantRecord } from "../../types.js";

const CREATE_ASSISTANT_COMMAND = "create_claw_assistant";
const LIST_ASSISTANT_COMMAND = "list_claw_assistant";
const PENDING_TOKEN_INPUT_TTL_MS = 10 * 60 * 1000;

const pendingTokenInputByUserId = new Map<number, number>();

const commandList = [
  {
    command: "start",
    description: "Start onboarding to create your own assistant bot",
  },
  {
    command: CREATE_ASSISTANT_COMMAND,
    description: "Start assistant setup (send your BotFather token next)",
  },
  {
    command: LIST_ASSISTANT_COMMAND,
    description: "Show all assistant bots you created",
  },
  {
    command: "gateway",
    description: "Open OpenClaw dashboard for one of your bots",
  },
  {
    command: "cancel_subscription",
    description: "Cancel your subscription (stops at period end)",
  },
] as const;

const BOT_USERNAME_SUFFIX = "_PIN_Claw_Bot";
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const GATEWAY_LINK_SESSION_TTL_HOURS = 12;
const TOKEN_ALREADY_TAKEN_MESSAGE = [
  "🙈 <b>Token already in use.</b>",
  "This token is already bound to another account.",
  "Please double-check and try again.",
].join("\n");

const commandText = (): string =>
  commandList
    .map((item) => `/${item.command} - ${item.description}`)
    .join("\n");
const replyHtml = (
  ctx: Context,
  text: string,
  other?: Parameters<Context["reply"]>[1],
) => ctx.reply(text, { parse_mode: "HTML", ...(other || {}) });

const normalizeBotUsernameBase = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "");

const suggestBotUsername = (ctx: Context): string => {
  const maxLength = 32;
  const baseMax = Math.max(1, maxLength - BOT_USERNAME_SUFFIX.length);
  const source =
    normalizeBotUsernameBase(ctx.from?.username || "") ||
    normalizeBotUsernameBase(ctx.from?.first_name || "") ||
    `User${ctx.from?.id ?? ""}`;
  const base = source.slice(0, baseMax) || "User";
  return `${base}${BOT_USERNAME_SUFFIX}`;
};

const welcomeMessage = (suggestedBotUsername: string): string =>
  [
    "🐾 <b>Welcome to PIN Claw Guide Bot</b> ✨",
    "",
    "Let's set up your very own Telegram Assistant! It's super easy 💕",
    "🌸 <b>Step 1</b> — Open @BotFather and send /newbot to create your new bot.",
    `🎀 <b>Step 2</b> — Pick a username, for example: <code>${suggestedBotUsername}</code> (BotFather has the final say).`,
    "🍰 <b>Step 3</b> — Send this command, then paste your token in the next message:",
    "<code>/create_claw_assistant</code>",
    "🪄 Sit back and relax~ We'll set up your OpenClaw container in a blink ✧˖°",
    "",
    "🔐 <b>Security tip:</b> Keep your token private and never share it.",
  ].join("\n");

const assistantsListMessage = (assistants: AssistantRecord[]): string => {
  if (!assistants.length) {
    return "🧸 <b>No assistant bots yet.</b>\nSend <code>/create_claw_assistant</code> to get started.";
  }

  const lines = assistants.map((assistant, index) => {
    const username = assistant.assistant_bot_username;
    return `${index + 1}. @${username} | status: ${assistant.container_status} | https://t.me/${username}`;
  });
  return ["<b>Your assistant bots:</b>", ...lines].join("\n");
};

const parseAssistantToken = (text: string | undefined): string | null => {
  if (!text) return null;
  const candidate = text
    .trim()
    .replace(/^token(?:_id)?\s*[:=]\s*/i, "")
    .trim();
  const normalized = candidate.replace(/\s+/g, "");
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(normalized)) return null;
  return normalized;
};

const markTokenInputPending = (telegramUserId: number): void => {
  pendingTokenInputByUserId.set(telegramUserId, Date.now());
};

const clearTokenInputPending = (telegramUserId: number): void => {
  pendingTokenInputByUserId.delete(telegramUserId);
};

const isTokenInputPending = (telegramUserId: number): boolean => {
  const createdAt = pendingTokenInputByUserId.get(telegramUserId);
  if (!createdAt) return false;

  if (Date.now() - createdAt > PENDING_TOKEN_INPUT_TTL_MS) {
    pendingTokenInputByUserId.delete(telegramUserId);
    return false;
  }

  return true;
};

interface AssistantBotIdentity {
  botId: number;
  username: string;
}

const validateAssistantBotToken = async (
  token: string,
): Promise<AssistantBotIdentity> => {
  const candidate = new Bot(token);
  await candidate.init();
  const botId = candidate.botInfo?.id;
  const username = candidate.botInfo?.username?.trim();
  if (!botId || !username) {
    throw new Error("Token is valid but bot metadata is missing.");
  }
  return { botId, username };
};

const deleteAssistantBotWebhook = async (token: string): Promise<void> => {
  const candidate = new Bot(token);
  await candidate.api.deleteWebhook({ drop_pending_updates: true });
};

const safeCreatePaymentLink = async (
  telegramUserId: number,
  telegramUsername: string | null,
): Promise<string | null> => {
  try {
    const session = await createPaymentSessionForUser(
      telegramUserId,
      telegramUsername,
    );
    return session?.subscribe_url ?? null;
  } catch (error: unknown) {
    const isUnauthorized =
      error instanceof BackendApiError && error.status === 401;
    console.error("Failed to create payment link", {
      telegramUserId,
      status: error instanceof BackendApiError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error || ""),
      hasApiInternalToken: Boolean(config.apiAuthToken.trim()),
      hint: isUnauthorized
        ? "Set bot API_INTERNAL_TOKEN to match apis API_INTERNAL_TOKEN."
        : undefined,
    });
    return null;
  }
};

const resolveBackendApiOrigin = (): URL | null => {
  try {
    return new URL(config.publicBaseUrl);
  } catch {
    return null;
  }
};

const isLocalhostHost = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
};

const isTelegramInlineUrlAllowed = (url: URL): boolean => {
  if (url.protocol !== "https:") return false;
  if (!url.hostname.trim()) return false;
  if (isLocalhostHost(url.hostname)) return false;
  return true;
};

const resolveGatewayPublicOrigin = (): URL | null => {
  const configured = resolveBackendApiOrigin();
  if (configured && isTelegramInlineUrlAllowed(configured)) {
    return new URL(configured.origin);
  }

  return null;
};

const buildAssistantGatewayUrl = (
  publicOrigin: string,
  telegramUserId: number,
  assistantId: number,
  sessionToken?: string,
): string => {
  const url = new URL(
    `/gateway/${telegramUserId}/bot/${assistantId}`,
    publicOrigin,
  );
  if (sessionToken) {
    url.searchParams.set("gateway_sid", sessionToken);
  }
  return url.toString();
};

const buildAssistantGatewayLinksText = (
  assistants: AssistantRecord[],
  publicOrigin: string,
  telegramUserId: number,
  sessionToken?: string,
): string => {
  return assistants
    .map(
      (assistant, index) =>
        `${index + 1}. @${assistant.assistant_bot_username} (${assistant.container_status || "unknown"})\n${buildAssistantGatewayUrl(publicOrigin, telegramUserId, assistant.id, sessionToken)}`,
    )
    .join("\n\n");
};

const provisionAssistantFromToken = async (
  ctx: Context,
  token: string,
): Promise<boolean> => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return false;

  if (token === config.telegram.token) {
    await replyHtml(
      ctx,
      "<b>This token belongs to the guide bot.</b>\nPlease use the token from the bot you created in @BotFather.",
    );
    return false;
  }

  await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);
  await replyHtml(
    ctx,
    "🔍 <b>Verifying your bot token...</b>\nPlease wait a moment.",
  );

  try {
    const botIdentity = await validateAssistantBotToken(token);

    // Create assistant without container - user needs to pay first
    const created = await createAssistantWithoutContainerViaApi({
      ownerTelegramUserId: telegramUserId,
      ownerTelegramUsername: ctx.from?.username ?? null,
      assistantBotId: botIdentity.botId,
      assistantBotToken: token,
      assistantBotUsername: botIdentity.username,
    });
    await deleteAssistantBotWebhook(token);

    const latestAssistants = await listAssistantsByOwnerViaApi(telegramUserId);
    const assistant = created.assistant;

    // Generate payment link
    const paymentLink = await safeCreatePaymentLink(
      telegramUserId,
      ctx.from?.username ?? null,
    );

    if (!paymentLink) {
      await replyHtml(
        ctx,
        [
          "✅ <b>Assistant registered successfully.</b>",
          `Bot link: https://t.me/${botIdentity.username}`,
          `Connected bot: @${botIdentity.username}`,
          ...(assistant.litellm_key_alias
            ? [`🔐 LiteLLM key assigned: ${assistant.litellm_key_alias}`]
            : []),
          "",
          "⚠️ <b>Payment link unavailable.</b> Your container will be created after you subscribe.",
          "Admin: ensure API_INTERNAL_TOKEN is set on both bot and API (same value), and API has PAYMENT_PUBLIC_BASE_URL. Check bot logs for «Failed to create payment link».",
          `🧸 You now have ${latestAssistants.length} assistant bot${latestAssistants.length === 1 ? "" : "s"}.`,
        ].join("\n"),
      );
      return true;
    }

    const keyboard = new InlineKeyboard().url(
      "💳 Subscribe to activate",
      paymentLink,
    );

    await replyHtml(
      ctx,
      [
        "✅ <b>Assistant registered successfully.</b>",
        `Bot link: https://t.me/${botIdentity.username}`,
        `Connected bot: @${botIdentity.username}`,
        ...(assistant.litellm_key_alias
          ? [`🔐 LiteLLM key assigned: ${assistant.litellm_key_alias}`]
          : []),
        "",
        "💡 <b>Next step:</b> Subscribe to a plan to activate your container.",
        "Your assistant will be ready to use immediately after payment.",
        `🧸 You now have ${latestAssistants.length} assistant bot${latestAssistants.length === 1 ? "" : "s"}.`,
      ].join("\n"),
      { reply_markup: keyboard },
    );

    return true;
  } catch (error: unknown) {
    console.error("Assistant bot setup failed", error);
    if (error instanceof BackendApiError && error.status === 409) {
      await replyHtml(ctx, TOKEN_ALREADY_TAKEN_MESSAGE);
      return false;
    }
    if (
      error instanceof Error &&
      error.message === "ASSISTANT_BOT_ALREADY_OWNED"
    ) {
      await replyHtml(ctx, TOKEN_ALREADY_TAKEN_MESSAGE);
      return false;
    }
    if (
      error instanceof Error &&
      error.message === "USER_ALREADY_HAS_ASSISTANT"
    ) {
      await replyHtml(
        ctx,
        [
          "⚠️ <b>You already have an assistant bot.</b>",
          "",
          "Currently, each user is limited to one assistant bot.",
          "If you want to create a new one, please delete your existing assistant first using the /my_assistants command.",
          "",
          "💡 <b>Tip:</b> You can update your existing bot's token by using the same token in /create_assistant command.",
        ].join("\n"),
      );
      return false;
    }
    await replyHtml(
      ctx,
      "<b>Failed to create assistant.</b>\nPlease verify your token and backend API availability, then try again.",
    );
    return false;
  }
};

export const registerTelegramCommands = (bot: Bot<Context>): void => {
  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error("Failed to set bot commands", error);
  });

  bot.command("start", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    const telegramUsername = ctx.from?.username ?? null;
    await ensureTelegramUserViaApi(telegramUserId, telegramUsername);
    await replyHtml(ctx, welcomeMessage(suggestBotUsername(ctx)));
  });

  const createAssistantCommandHandler = async (ctx: Context): Promise<void> => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    markTokenInputPending(telegramUserId);
    await replyHtml(
      ctx,
      [
        "<b>Please send your BotFather token in the next message.</b>",
        "Example: <code>123456789:ABCDefghIJKLmnopQRSTuvwxYZ</code>",
      ].join("\n"),
    );
  };

  bot.command(CREATE_ASSISTANT_COMMAND, createAssistantCommandHandler);

  const listAssistantCommandHandler = async (ctx: Context): Promise<void> => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);
    const assistants = await listAssistantsByOwnerViaApi(telegramUserId);
    
    if (!assistants.length) {
      await replyHtml(
        ctx,
        "🧸 <b>No assistant bots yet.</b>\nSend <code>/create_claw_assistant</code> to get started.",
      );
      return;
    }

    // 由于限制一个用户只能有一个 assistant，直接显示这个 assistant
    const assistant = assistants[0];
    const keyboard = new InlineKeyboard()
      .text("🗑 Delete Assistant", `delete_assistant:${assistant.id}`)
      .row()
      .text("📊 Manage Subscription", "manage_subscription")
      .row()
      .text("🔄 Refresh Status", "refresh_assistant_status");

    await replyHtml(
      ctx,
      [
        "<b>Your Assistant Bot</b>",
        "",
        `🤖 <b>Bot:</b> @${assistant.assistant_bot_username}`,
        `🔗 <b>Link:</b> https://t.me/${assistant.assistant_bot_username}`,
        `📊 <b>Status:</b> ${assistant.container_status || "unknown"}`,
        ...(assistant.litellm_key_alias
          ? [`🔐 <b>LiteLLM Key:</b> ${assistant.litellm_key_alias}`]
          : []),
        "",
        "💡 <b>Actions:</b>",
        "• Delete to create a new one",
        "• Manage your subscription plan",
      ].join("\n"),
      { reply_markup: keyboard },
    );
  };

  bot.command(LIST_ASSISTANT_COMMAND, listAssistantCommandHandler);

  bot.command("gateway", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);
    const assistants = await listAssistantsByOwnerViaApi(telegramUserId);

    if (!assistants.length) {
      await replyHtml(
        ctx,
        `<b>No assistant bots found.</b>\nPlease create one first with <code>/${CREATE_ASSISTANT_COMMAND}</code>.`,
      );
      return;
    }

    const publicBase = resolveGatewayPublicOrigin();
    if (!publicBase) {
      await replyHtml(
        ctx,
        [
          "<b>No public HTTPS URL is available.</b>",
          "Set <code>BACKEND_API_BASE_URL</code> to your public HTTPS API domain and try again.",
        ].join("\n"),
      );
      return;
    }

    const publicOrigin = publicBase.origin;
    let sessionToken: string | null = null;
    try {
      const session = await createGatewaySessionViaApi(
        telegramUserId,
        GATEWAY_LINK_SESSION_TTL_HOURS,
      );
      sessionToken = session.session_token;
    } catch (error: unknown) {
      console.error("Failed to create gateway session for command", {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error || ""),
      });
      await replyHtml(
        ctx,
        "<b>Failed to create Gateway sign-in session.</b>\nPlease try again shortly.",
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const assistant of assistants) {
      const buttonLabel = `@${assistant.assistant_bot_username} (${assistant.container_status || "unknown"})`;
      const url = buildAssistantGatewayUrl(
        publicOrigin,
        telegramUserId,
        assistant.id,
        sessionToken,
      );
      keyboard.url(buttonLabel, url).row();
    }

    try {
      await replyHtml(ctx, "<b>Choose a bot to open:</b>", {
        reply_markup: keyboard,
      });
    } catch (error: unknown) {
      console.error("Failed to send gateway inline keyboard", {
        telegramUserId,
        publicOrigin,
        error: error instanceof Error ? error.message : String(error || ""),
      });

      const links = buildAssistantGatewayLinksText(
        assistants,
        publicOrigin,
        telegramUserId,
        sessionToken,
      );
      await replyHtml(
        ctx,
        [
          "<b>Failed to send Gateway buttons.</b> Falling back to plain text links.",
          `Gateway base URL: <code>${publicOrigin}</code>`,
          "",
          links,
        ].join("\n"),
      );
    }
  });

  bot.command("cancel_subscription", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);

    if (!isPaymentEnabled()) {
      await replyHtml(
        ctx,
        "<b>Payment service is not configured.</b>\nPlease contact the admin.",
      );
      return;
    }

    try {
      const result = await cancelUserSubscription(telegramUserId);
      const periodEnd = new Date(
        result.current_period_end,
      ).toLocaleDateString();
      await replyHtml(
        ctx,
        [
          "✅ <b>Subscription cancelled successfully.</b>",
          `Your subscription will remain active until <b>${periodEnd}</b>.`,
          "After that, your containers will be stopped but not deleted.",
          "You can resubscribe anytime to resume service.",
        ].join("\n"),
      );
    } catch (error: unknown) {
      console.error("Failed to cancel subscription", {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof BackendApiError && error.status === 404) {
        await replyHtml(
          ctx,
          "<b>No active subscription found.</b>\nYou don't have a subscription to cancel.",
        );
      } else {
        await replyHtml(
          ctx,
          "<b>Failed to cancel subscription.</b>\nPlease try again later or contact support.",
        );
      }
    }
  });

  // Callback query handlers for inline buttons
  bot.callbackQuery(/^delete_assistant:(\d+)$/, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const assistantId = parseInt(ctx.match[1], 10);
    if (!assistantId) {
      await ctx.answerCallbackQuery({ text: "Invalid assistant ID" });
      return;
    }

    // 确认删除
    const keyboard = new InlineKeyboard()
      .text("⚠️ Yes, Delete", `confirm_delete:${assistantId}`)
      .text("❌ Cancel", "cancel_delete");

    await ctx.editMessageText(
      [
        "⚠️ <b>Confirm Deletion</b>",
        "",
        "Are you sure you want to delete this assistant?",
        "",
        "This will:",
        "• Stop and destroy the container",
        "• Remove the bot configuration",
        "• Keep your subscription active (you can create a new assistant)",
        "",
        "<b>This action cannot be undone.</b>",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^confirm_delete:(\d+)$/, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const assistantId = parseInt(ctx.match[1], 10);
    if (!assistantId) {
      await ctx.answerCallbackQuery({ text: "Invalid assistant ID" });
      return;
    }

    await ctx.editMessageText("🔄 <b>Deleting assistant...</b>\nPlease wait.", {
      parse_mode: "HTML",
    });

    try {
      // 调用删除 API
      const response = await deleteAssistantViaApi(assistantId);

      if (response.deleted) {
        await ctx.editMessageText(
          [
            "✅ <b>Assistant deleted successfully.</b>",
            "",
            "You can now create a new assistant using /create_claw_assistant",
            "Your subscription remains active and will apply to your next assistant.",
          ].join("\n"),
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.editMessageText(
          "<b>Failed to delete assistant.</b>\nThe assistant may have already been deleted.",
          { parse_mode: "HTML" },
        );
      }
    } catch (error: unknown) {
      console.error("Failed to delete assistant", {
        telegramUserId,
        assistantId,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.editMessageText(
        "<b>Failed to delete assistant.</b>\nPlease try again later.",
        { parse_mode: "HTML" },
      );
    }

    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("cancel_delete", async (ctx) => {
    await ctx.editMessageText("❌ <b>Deletion cancelled.</b>", {
      parse_mode: "HTML",
    });
    await ctx.answerCallbackQuery({ text: "Cancelled" });
  });

  bot.callbackQuery("manage_subscription", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    const paymentLink = await safeCreatePaymentLink(
      telegramUserId,
      ctx.from?.username ?? null,
    );

    if (!paymentLink) {
      await ctx.answerCallbackQuery({
        text: "Payment link unavailable",
        show_alert: true,
      });
      return;
    }

    const keyboard = new InlineKeyboard()
      .url("💳 Manage Subscription", paymentLink)
      .row()
      .text("❌ Cancel Subscription", "confirm_cancel_subscription");

    await ctx.editMessageText(
      [
        "📊 <b>Subscription Management</b>",
        "",
        "• <b>Upgrade/Downgrade:</b> Click the button below to change your plan",
        "• <b>Cancel:</b> Cancel your subscription (stays active until period end)",
        "",
        "Your subscription applies to all your assistants.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("confirm_cancel_subscription", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text("⚠️ Yes, Cancel Subscription", "do_cancel_subscription")
      .text("❌ Keep Subscription", "keep_subscription");

    await ctx.editMessageText(
      [
        "⚠️ <b>Confirm Subscription Cancellation</b>",
        "",
        "Are you sure you want to cancel your subscription?",
        "",
        "• Your subscription will remain active until the end of the current billing period",
        "• After that, your containers will be stopped",
        "• You can resubscribe anytime",
        "",
        "<b>Note:</b> This will not delete your assistant bot configuration.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
      },
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("do_cancel_subscription", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    await ctx.editMessageText("🔄 <b>Cancelling subscription...</b>", {
      parse_mode: "HTML",
    });

    try {
      const result = await cancelUserSubscription(telegramUserId);
      const periodEnd = new Date(
        result.current_period_end,
      ).toLocaleDateString();
      await ctx.editMessageText(
        [
          "✅ <b>Subscription cancelled successfully.</b>",
          `Your subscription will remain active until <b>${periodEnd}</b>.`,
          "After that, your containers will be stopped but not deleted.",
          "You can resubscribe anytime to resume service.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (error: unknown) {
      console.error("Failed to cancel subscription", {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof BackendApiError && error.status === 404) {
        await ctx.editMessageText(
          "<b>No active subscription found.</b>\nYou don't have a subscription to cancel.",
          { parse_mode: "HTML" },
        );
      } else {
        await ctx.editMessageText(
          "<b>Failed to cancel subscription.</b>\nPlease try again later or contact support.",
          { parse_mode: "HTML" },
        );
      }
    }

    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("keep_subscription", async (ctx) => {
    await ctx.editMessageText("✅ <b>Subscription kept active.</b>", {
      parse_mode: "HTML",
    });
    await ctx.answerCallbackQuery({ text: "Subscription kept" });
  });

  bot.callbackQuery("refresh_assistant_status", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    try {
      const assistants = await listAssistantsByOwnerViaApi(telegramUserId);
      if (!assistants.length) {
        await ctx.answerCallbackQuery({
          text: "No assistants found",
          show_alert: true,
        });
        return;
      }

      const assistant = assistants[0];
      const keyboard = new InlineKeyboard()
        .text("🗑 Delete Assistant", `delete_assistant:${assistant.id}`)
        .row()
        .text("📊 Manage Subscription", "manage_subscription")
        .row()
        .text("🔄 Refresh Status", "refresh_assistant_status");

      await ctx.editMessageText(
        [
          "<b>Your Assistant Bot</b>",
          "",
          `🤖 <b>Bot:</b> @${assistant.assistant_bot_username}`,
          `🔗 <b>Link:</b> https://t.me/${assistant.assistant_bot_username}`,
          `📊 <b>Status:</b> ${assistant.container_status || "unknown"}`,
          ...(assistant.litellm_key_alias
            ? [`🔐 <b>LiteLLM Key:</b> ${assistant.litellm_key_alias}`]
            : []),
          "",
          "💡 <b>Actions:</b>",
          "• Delete to create a new one",
          "• Manage your subscription plan",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
      );
      await ctx.answerCallbackQuery({ text: "Status refreshed" });
    } catch (error: unknown) {
      console.error("Failed to refresh assistant status", error);
      await ctx.answerCallbackQuery({
        text: "Failed to refresh status",
        show_alert: true,
      });
    }
  });

  bot.hears(/^\s*\/\s*$/, async (ctx) => {
    await replyHtml(ctx, `<b>Available commands:</b>\n${commandText()}`);
  });

  bot.on("message:text", async (ctx, next) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId || !isTokenInputPending(telegramUserId)) {
      await next();
      return;
    }

    const rawText = ctx.message.text.trim();
    if (!rawText) {
      await replyHtml(ctx, "Please send your BotFather token as plain text.");
      return;
    }

    if (rawText.startsWith("/")) {
      await next();
      return;
    }

    const token = parseAssistantToken(rawText);
    if (!token) {
      await replyHtml(
        ctx,
        [
          "<b>This does not look like a valid BotFather token.</b>",
          "Please resend it in this format: <code>123456789:ABCDefghIJKLmnopQRSTuvwxYZ</code>",
        ].join("\n"),
      );
      return;
    }

    const created = await provisionAssistantFromToken(ctx, token);
    if (created) {
      clearTokenInputPending(telegramUserId);
    }
  });
};
