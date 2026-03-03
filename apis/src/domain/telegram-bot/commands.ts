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
const VNC_ACCESS_COMMAND = "vnc_access";
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
  {
    command: VNC_ACCESS_COMMAND,
    description: "Access remote desktop for browser operations",
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

const parseAssistantToken = (
  text: string | undefined,
): { token: string; id: number } | null => {
  if (!text) return null;
  const candidate = text
    .trim()
    .replace(/^token(?:_id)?\s*[:=]\s*/i, "")
    .trim();
  const normalized = candidate.replace(/\s+/g, "");
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(normalized)) return null;

  // 从 token 中提取 bot ID (token 格式: 123456789:ABCdef...)
  const parts = normalized.split(":");
  const botId = Number.parseInt(parts[0] || "", 10);
  if (!Number.isFinite(botId)) return null;

  return { token: normalized, id: botId };
};

// 使用数据库存储待处理动作（支持集群部署）
import { pool } from "../common/db/core.js";

const markTokenInputPending = async (telegramUserId: number): Promise<void> => {
  const PENDING_TOKEN_INPUT_TTL_MS = 10 * 60 * 1000; // 10分钟
  const expiresAt = new Date(Date.now() + PENDING_TOKEN_INPUT_TTL_MS);

  await pool.query(
    `INSERT INTO user_pending_actions (user_id, action_type, expires_at)
     SELECT id, 'token_input', $2
     FROM users
     WHERE telegram_user_id = $1
     ON CONFLICT (user_id, action_type) 
     DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [telegramUserId, expiresAt],
  );
};

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

  await ensureTelegramUserViaApi(telegramUserId, ctx.from?.username ?? null);

  // 检查用户是否已有助理
  const existingAssistants = await listAssistantsByOwnerViaApi(telegramUserId);

  if (existingAssistants.length === 0) {
    // 用户还没有助理，提供两种选择
    const keyboard = new InlineKeyboard()
      .text("🚀 Quick Start", "quick_start")
      .row()
      .text("🔧 Use Own Bot", "use_own_bot");

    await replyHtml(
      ctx,
      [
        "🤖 <b>Create Your AI Assistant</b>",
        "",
        "<b>Choose your setup method:</b>",
        "",
        "🚀 <b>Quick Start</b> (Recommended)",
        "   • Start using immediately",
        "   • Chat through this guide bot",
        "   • Perfect for most users",
        "",
        "🔧 <b>Use Own Bot</b>",
        "   • Create custom bot via @BotFather",
        "   • Chat directly with your bot",
        "   • Advanced customization",
      ].join("\n"),
      { reply_markup: keyboard },
    );

    return true;
  }

  // 用户已有助理，检查是否有活跃订阅
  const assistantId = existingAssistants[0]?.id;

  // 尝试创建 payment session，如果失败说明已有活跃订阅
  const paymentLink = await safeCreatePaymentLink(
    telegramUserId,
    ctx.from?.username ?? null,
    assistantId,
  );

  if (!paymentLink) {
    // 已有活跃订阅，提示使用管理命令
    await replyHtml(
      ctx,
      [
        "✅ <b>You already have an assistant!</b>",
        "",
        "Use these commands to manage your assistant:",
        "",
        "📋 /list_claw_assistant - View your assistant",
        "💳 /my_subscription - Manage subscription",
        "🌐 /gateway - Open dashboard",
      ].join("\n"),
    );
    return true;
  }

  // 有 assistant 但无活跃订阅，直接显示支付链接（重新订阅）
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

  // Quick Start 模式：不绑定 bot，直接创建助理
  bot.callbackQuery("quick_start", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    await ctx.editMessageText("🔄 <b>Setting up your assistant...</b>", {
      parse_mode: "HTML",
    });

    try {
      // 创建助理（不绑定 bot）
      await createAssistantWithoutContainerViaApi({
        ownerTelegramUserId: telegramUserId,
        ownerTelegramUsername: ctx.from?.username ?? null,
        // bot 字段留空 - Quick Start 模式
      });

      // 创建成功，生成支付链接
      const assistants = await listAssistantsByOwnerViaApi(telegramUserId);
      const assistantId = assistants[0]?.id;

      const paymentLink = await safeCreatePaymentLink(
        telegramUserId,
        ctx.from?.username ?? null,
        assistantId,
      );

      if (!paymentLink) {
        await ctx.editMessageText(
          [
            "✅ <b>Your assistant is registered.</b>",
            "",
            "⚠️ Payment is temporarily unavailable. Please try again shortly.",
          ].join("\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      const keyboard = new InlineKeyboard().url(
        "💳 Subscribe to activate",
        paymentLink,
      );

      await ctx.editMessageText(
        [
          "✅ <b>Assistant created successfully!</b>",
          "",
          "🚀 <b>Quick Start Mode</b>",
          "   • Chat with me to use your assistant",
          "   • No need to create separate bot",
          "",
          "💡 <b>Next step:</b> Subscribe to activate your assistant.",
          "",
          "After subscribing, your assistant will be ready to use!",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
      );
    } catch (error: unknown) {
      const is409 = error instanceof BackendApiError && error.status === 409;
      const isDup =
        error instanceof Error &&
        error.message === "USER_ALREADY_HAS_ASSISTANT";

      if (is409 || isDup) {
        await ctx.editMessageText(
          [
            "⚠️ <b>You already have an assistant</b>",
            "",
            "Send /list_claw_assistant to view your assistants.",
          ].join("\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      console.error("Quick start setup failed", error);
      await ctx.editMessageText(
        [
          "❌ <b>Failed to create assistant</b>",
          "",
          "Please try again or contact support.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    }

    await ctx.answerCallbackQuery();
  });

  // Advanced 模式：提示用户创建自己的 bot
  bot.callbackQuery("use_own_bot", async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) return;

    await ctx.editMessageText(
      [
        "🔧 <b>Advanced Setup - Use Your Own Bot</b>",
        "",
        "To create a custom Telegram bot:",
        "",
        "1️⃣ Open @BotFather",
        "2️⃣ Send /newbot",
        "3️⃣ Follow instructions to create your bot",
        "4️⃣ Copy the bot token (like <code>123456:ABC-DEF...</code>)",
        "5️⃣ <b>Send the token HERE (in this chat)</b>",
        "",
        "⚠️ <b>IMPORTANT:</b> Send the token in THIS chat, not your new bot!",
        "",
        "⏱️ You have 10 minutes to send your bot token.",
        "",
        "<b>Benefits:</b>",
        "• Chat directly with your own bot",
        "• Custom bot name and avatar",
        "• Also works through this guide bot",
      ].join("\n"),
      { parse_mode: "HTML" },
    );

    await markTokenInputPending(telegramUserId);
    await ctx.answerCallbackQuery();
  });

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

    // 处理用户输入的 bot token (Advanced 模式)
    const tokenParsed = parseAssistantToken(rawText);
    if (!tokenParsed) {
      await replyHtml(
        ctx,
        [
          "❌ <b>Invalid bot token format</b>",
          "",
          "Bot tokens look like: <code>123456789:ABCdefGHIjklMNOpqrsTUVwxyz</code>",
          "",
          "Please:",
          "• Get your token from @BotFather",
          "• Copy the entire token",
          "• Send it here",
          "",
          "Or send /create_claw_assistant to start over.",
        ].join("\n"),
      );
      return;
    }

    // 创建助理
    await replyHtml(ctx, "🔄 <b>Setting up your assistant...</b>");

    try {
      await createAssistantWithoutContainerViaApi({
        ownerTelegramUserId: telegramUserId,
        ownerTelegramUsername: ctx.from?.username ?? null,
        assistantBotId: tokenParsed.id,
        assistantBotToken: tokenParsed.token,
        assistantBotUsername: "", // 会自动从 Telegram 获取
      });

      // 创建成功，生成支付链接
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
        return;
      }

      const keyboard = new InlineKeyboard().url(
        "💳 Subscribe to activate",
        paymentLink,
      );

      await replyHtml(
        ctx,
        [
          "✅ <b>Assistant created successfully!</b>",
          "",
          `🤖 Bot ID: ${tokenParsed.id}`,
          "",
          "💡 <b>Next step:</b> Subscribe to activate your assistant.",
          "",
          "After subscribing, your assistant will be ready to use!",
        ].join("\n"),
        { reply_markup: keyboard },
      );
    } catch (error: unknown) {
      const is409 = error instanceof BackendApiError && error.status === 409;
      const isDup =
        error instanceof Error &&
        (error.message === "USER_ALREADY_HAS_ASSISTANT" ||
          error.message === "ASSISTANT_BOT_ALREADY_OWNED");

      if (is409 || isDup) {
        await replyHtml(
          ctx,
          [
            "⚠️ <b>Assistant already exists</b>",
            "",
            error.message === "ASSISTANT_BOT_ALREADY_OWNED"
              ? "This bot is already being used by another user."
              : "You already have an assistant registered.",
            "",
            "Send /list_claw_assistant to view your assistants.",
          ].join("\n"),
        );
        return;
      }

      console.error("Failed to create assistant from token", error);
      await replyHtml(
        ctx,
        [
          "❌ <b>Failed to create assistant</b>",
          "",
          "Please make sure:",
          "• The bot token is valid",
          "• The bot exists in @BotFather",
          "• The token has not been revoked",
          "",
          "Send /create_claw_assistant to try again.",
        ].join("\n"),
      );
    }
  });

  // VNC 远程桌面访问命令
  bot.command(VNC_ACCESS_COMMAND, async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      await replyHtml(ctx, "❌ Unable to identify user.");
      return;
    }

    try {
      // 确保用户已注册
      const user = await ensureTelegramUserViaApi(telegramUserId);

      // 获取用户的助理列表
      const assistants = await listAssistantsByOwnerViaApi(user.id);

      if (!assistants.length) {
        await replyHtml(
          ctx,
          [
            "❌ <b>No assistant found</b>",
            "",
            "You need to create an assistant first.",
            "",
            "Send /create_claw_assistant to get started.",
          ].join("\n"),
        );
        return;
      }

      // 使用第一个助理
      const assistant = assistants[0];
      if (!assistant) {
        await replyHtml(ctx, "❌ No assistant available");
        return;
      }

      // 请求 VNC 访问令牌
      const baseUrl = config.publicBaseUrl || `http://localhost:${config.port}`;
      const response = await fetch(
        `${baseUrl}/api/vnc/request-access/${assistant.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: `session_id=internal-telegram-bot`,
          },
        },
      );

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        const errorMsg = errorData.error || "Failed to generate access link";

        if (errorMsg === "Container not running") {
          await replyHtml(
            ctx,
            [
              "⚠️ <b>Container not running</b>",
              "",
              "Your assistant container is not currently running.",
              "Please start your assistant first, then try again.",
            ].join("\n"),
          );
          return;
        }

        throw new Error(errorMsg);
      }

      const vncData = (await response.json()) as {
        url: string;
        expiresAt: string;
      };

      const keyboard = new InlineKeyboard().url("🖥️ 打开远程桌面", vncData.url);

      await replyHtml(
        ctx,
        [
          "✅ <b>远程桌面访问链接已生成</b>",
          "",
          "点击下方按钮打开您助理的远程桌面。",
          "",
          "🔐 默认密码: <code>pinai123</code>",
          "",
          "⏱️ 链接有效期: 15 分钟",
          "",
          "💡 <b>用途:</b>",
          "• 在浏览器中输入密码",
          "• 完成验证码验证",
          "• 处理需要 GUI 交互的任务",
        ].join("\n"),
        { reply_markup: keyboard },
      );
    } catch (error: unknown) {
      console.error("VNC access command error:", error);
      await replyHtml(
        ctx,
        [
          "❌ <b>Failed to generate VNC access</b>",
          "",
          error instanceof Error ? error.message : "Unknown error occurred",
          "",
          "Please try again later.",
        ].join("\n"),
      );
    }
  });
};
