import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../common/config.js";
import {
  BackendApiError,
  createGatewaySessionViaApi,
  createPaymentSessionForUser,
  createAssistantWithoutContainerViaApi,
  cancelUserSubscription,
  ensureTelegramUserViaApi,
  listAssistantsByOwnerViaApi,
} from "./client.js";
import type { AssistantRecord } from "../../types.js";

const CREATE_ASSISTANT_COMMAND = "create_claw_assistant";
const LIST_ASSISTANT_COMMAND = "list_claw_assistant";
const commandList = [
  {
    command: "start",
    description: "Get started with your AI assistant",
  },
  {
    command: CREATE_ASSISTANT_COMMAND,
    description: "Create your AI assistant",
  },
  {
    command: LIST_ASSISTANT_COMMAND,
    description: "Show your assistant status",
  },
  {
    command: "gateway",
    description: "Open OpenClaw dashboard",
  },
] as const;

const GATEWAY_LINK_SESSION_TTL_HOURS = 12;
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const commandText = (): string =>
  commandList
    .map((item) => `/${item.command} - ${item.description}`)
    .join("\n");
const replyHtml = (
  ctx: Context,
  text: string,
  other?: Parameters<Context["reply"]>[1],
) => ctx.reply(text, { parse_mode: "HTML", ...(other || {}) });

const welcomeMessage = (): string =>
  [
    "🐾 <b>Welcome to PIN Claw!</b>",
    "",
    "Your personal AI assistant is just one step away.",
    "",
    "Send /create_claw_assistant to get started.",
  ].join("\n");

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

// 使用数据库存储待处理动作（支持集群部署）
import { pool } from "../common/db/core.js";

const clearTokenInputPending = async (
  telegramUserId: number,
): Promise<void> => {
  await pool.query(
    `DELETE FROM user_pending_actions
     WHERE user_id IN (SELECT id FROM users WHERE telegram_user_id = $1)
       AND action_type = 'token_input'`,
    [telegramUserId],
  );
};

const isTokenInputPending = async (
  telegramUserId: number,
): Promise<boolean> => {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_pending_actions upa
       JOIN users u ON u.id = upa.user_id
       WHERE u.telegram_user_id = $1
         AND upa.action_type = 'token_input'
         AND upa.expires_at > NOW()
     ) as exists`,
    [telegramUserId],
  );

  return result.rows[0]?.exists ?? false;
};

const safeCreatePaymentLink = async (
  telegramUserId: number,
  telegramUsername: string | null,
  assistantId?: number,
): Promise<string | null> => {
  try {
    const session = await createPaymentSessionForUser(
      telegramUserId,
      telegramUsername,
      assistantId,
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

const provisionAssistantWithGuideBot = async (
  ctx: Context,
): Promise<boolean> => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) return false;

  const guideBotId = ctx.me.id;
  const guideBotUsername = ctx.me.username;
  const guideBotToken = config.telegram.token;

  await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);

  try {
    await createAssistantWithoutContainerViaApi({
      ownerTelegramUserId: telegramUserId,
      ownerTelegramUsername: ctx.from?.username ?? null,
      assistantBotId: guideBotId,
      assistantBotToken: guideBotToken,
      assistantBotUsername: guideBotUsername,
    });
  } catch (error: unknown) {
    const is409 = error instanceof BackendApiError && error.status === 409;
    const isLocalDup =
      error instanceof Error && error.message === "USER_ALREADY_HAS_ASSISTANT";

    if (!is409 && !isLocalDup) {
      console.error("Assistant setup failed", error);
      await replyHtml(
        ctx,
        "<b>Something went wrong.</b>\nPlease try again later.",
      );
      return false;
    }
    // User already has an assistant — fall through to show payment link
  }

  // 获取助理 ID（可能是刚创建的，或已存在的）
  const assistants = await listAssistantsByOwnerViaApi(telegramUserId);
  const assistantId = assistants[0]?.id;

  const paymentLink = await safeCreatePaymentLink(
    telegramUserId,
    ctx.from?.username ?? null,
    assistantId,
  );

  if (!paymentLink) {
    await replyHtml(
      ctx,
      [
        "✅ <b>Your assistant is registered.</b>",
        "",
        "⚠️ Payment is temporarily unavailable. Please try again shortly.",
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
      "✅ <b>Your assistant is ready!</b>",
      "",
      "Subscribe to a plan to activate it.",
      "Your assistant will be available immediately after payment.",
    ].join("\n"),
    { reply_markup: keyboard },
  );

  return true;
};

export const registerTelegramCommands = (bot: Bot<Context>): void => {
  bot.api.setMyCommands(commandList).catch((error: unknown) => {
    console.error("Failed to set bot commands", error);
  });

  bot.command("start", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);
    await clearTokenInputPending(telegramUserId);
    await replyHtml(ctx, welcomeMessage());
  });

  bot.command(CREATE_ASSISTANT_COMMAND, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await clearTokenInputPending(telegramUserId);
    await replyHtml(ctx, "🔄 <b>Setting up your assistant...</b>");
    await provisionAssistantWithGuideBot(ctx);
  });

  bot.command(LIST_ASSISTANT_COMMAND, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;
    await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);
    await clearTokenInputPending(telegramUserId);
    const assistants = await listAssistantsByOwnerViaApi(telegramUserId);

    if (!assistants.length) {
      await replyHtml(
        ctx,
        "No assistant yet. Send /create_claw_assistant to get started.",
      );
      return;
    }

    for (let i = 0; i < assistants.length; i++) {
      const assistant = assistants[i];
      if (!assistant) continue;

      const keyboard = new InlineKeyboard()
        .text("📊 Manage Subscription", "manage_subscription")
        .row()
        .text("🔄 Refresh Status", "refresh_assistant_status");

      await replyHtml(
        ctx,
        [
          `<b>Your Assistant${assistants.length > 1 ? ` #${i + 1}` : ""}</b>`,
          "",
          `📊 <b>Status:</b> ${assistant.container_status || "unknown"}`,
          ...(assistant.litellm_key_alias
            ? [`🔐 <b>LiteLLM Key:</b> ${assistant.litellm_key_alias}`]
            : []),
        ].join("\n"),
        { reply_markup: keyboard },
      );
    }
  });

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

  // Callback query handlers for inline buttons
  bot.callbackQuery("manage_subscription", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    // 获取用户的助理（限制只有一个）
    const assistants = await listAssistantsByOwnerViaApi(telegramUserId);
    const assistantId = assistants[0]?.id;

    const paymentLink = await safeCreatePaymentLink(
      telegramUserId,
      ctx.from?.username ?? null,
      assistantId,
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
      if (!assistant) {
        await ctx.answerCallbackQuery({
          text: "Assistant not found",
          show_alert: true,
        });
        return;
      }

      const keyboard = new InlineKeyboard()
        .text("📊 Manage Subscription", "manage_subscription")
        .row()
        .text("🔄 Refresh Status", "refresh_assistant_status");

      await ctx.editMessageText(
        [
          "<b>Your Assistant</b>",
          "",
          `📊 <b>Status:</b> ${assistant.container_status || "unknown"}`,
          ...(assistant.litellm_key_alias
            ? [`🔐 <b>LiteLLM Key:</b> ${assistant.litellm_key_alias}`]
            : []),
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
    if (!telegramUserId || !(await isTokenInputPending(telegramUserId))) {
      await next();
      return;
    }

    await clearTokenInputPending(telegramUserId);

    const rawText = ctx.message.text.trim();
    if (rawText.startsWith("/")) {
      await next();
      return;
    }

    // Legacy compat: user pasted a bot token from old flow
    if (parseAssistantToken(rawText)) {
      await replyHtml(
        ctx,
        [
          "No need to enter a bot token — we've simplified the setup!",
          "",
          "Send /create_claw_assistant to create your assistant directly.",
        ].join("\n"),
      );
      return;
    }

    await next();
  });
};
