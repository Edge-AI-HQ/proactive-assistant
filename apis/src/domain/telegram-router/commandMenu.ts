import type { Request, Response } from "express";
import { pool } from "../common/db/core.js";
import { config } from "../common/config.js";
import { QUICKSTART_SYNTHETIC_BOT_TOKEN } from "../container/providers/shared/telegram_runtime_secret.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TelegramBotCommand = { command: string; description: string };

type CommandMenuPayload = {
  method: "setMyCommands" | "deleteMyCommands";
  /** The original Telegram API request body from OpenClaw. */
  commands: { commands?: TelegramBotCommand[] } | null;
  botToken: string;
  /** Owner chat ID — supplied by the plugin from OWNER_TELEGRAM_USER_ID env. */
  ownerChatId?: string;
};

type AssistantOwner = {
  assistant_id: number;
  owner_telegram_user_id: string;
  assistant_bot_token: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isQuickStartToken = (token: string): boolean =>
  token === QUICKSTART_SYNTHETIC_BOT_TOKEN || token.startsWith("0:");

/**
 * Look up the assistant that owns the given bot token.
 * For QuickStart containers the token is synthetic — caller must use ownerChatId.
 */
async function findAssistantByBotToken(botToken: string): Promise<AssistantOwner | null> {
  if (isQuickStartToken(botToken)) return null;
  const result = await pool.query<AssistantOwner>(
    `SELECT
       a.id AS assistant_id,
       u.telegram_user_id AS owner_telegram_user_id,
       a.assistant_bot_token
     FROM assistants a
     JOIN users u ON u.id = a.owner_user_id
     WHERE a.assistant_bot_token = $1
     LIMIT 1`,
    [botToken],
  );
  return result.rows[0] ?? null;
}

/**
 * Call the Telegram Bot API `setMyCommands` scoped to a single chat.
 * Uses the platform Guide Bot token so that QuickStart users see commands
 * in the shared bot without interfering with other users.
 */
async function setCommandsForChat(
  chatId: string,
  commands: TelegramBotCommand[],
): Promise<boolean> {
  const token = config.telegram.token;
  if (!token?.trim()) return false;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands,
          scope: { type: "chat", chat_id: Number(chatId) },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`❌ setMyCommands(chat=${chatId}) failed status=${resp.status} body=${body.slice(0, 300)}`);
    }
    return resp.ok;
  } catch (err) {
    console.error(`❌ setMyCommands(chat=${chatId}) network error:`, err);
    return false;
  }
}

async function deleteCommandsForChat(chatId: string): Promise<boolean> {
  const token = config.telegram.token;
  if (!token?.trim()) return false;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/deleteMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: { type: "chat", chat_id: Number(chatId) },
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * For Advanced users with their own bot: call setMyCommands directly on
 * their bot (no scope needed — the entire bot belongs to one user).
 */
async function setCommandsForOwnBot(
  botToken: string,
  commands: TelegramBotCommand[],
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/setMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

async function deleteCommandsForOwnBot(botToken: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/deleteMyCommands`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/internal/commands
 *
 * Receives intercepted setMyCommands / deleteMyCommands calls from the
 * telegram-api-proxy plugin running inside OpenClaw containers, and applies
 * them with per-user scoping via BotCommandScopeChat.
 */
export async function handleCommandMenuUpdate(req: Request, res: Response): Promise<void> {
  try {
    const payload = req.body as CommandMenuPayload;
    if (!payload?.method || !payload?.botToken) {
      res.status(400).json({ ok: false, description: "missing method or botToken" });
      return;
    }

    const { method, botToken } = payload;
    const commands: TelegramBotCommand[] = payload.commands?.commands ?? [];
    const isDelete = method === "deleteMyCommands";

    // --- Advanced user (has own bot token) ---
    if (!isQuickStartToken(botToken)) {
      const assistant = await findAssistantByBotToken(botToken);
      if (!assistant) {
        console.warn(`⚠️ Command menu: no assistant found for bot token`);
        res.status(404).json({ ok: false, description: "assistant not found" });
        return;
      }

      // Own bot: call Telegram directly (no scope needed).
      const ok = isDelete
        ? await deleteCommandsForOwnBot(botToken)
        : await setCommandsForOwnBot(botToken, commands);

      // Mirror on Guide Bot with chat scope so commands show when user
      // interacts via the shared entry point.
      if (assistant.owner_telegram_user_id) {
        isDelete
          ? await deleteCommandsForChat(assistant.owner_telegram_user_id)
          : await setCommandsForChat(assistant.owner_telegram_user_id, commands);
      }

      console.log(
        `📋 Command menu ${method} for advanced user tg=${assistant.owner_telegram_user_id} ` +
          `commands=${commands.length} ok=${ok}`,
      );
      res.status(200).json({ ok: true });
      return;
    }

    // --- QuickStart user (synthetic bot token) ---
    // The plugin includes ownerChatId from the container's OWNER_TELEGRAM_USER_ID env.
    const ownerChatId = payload.ownerChatId?.trim();
    if (!ownerChatId) {
      console.warn(`⚠️ Command menu: QuickStart container missing ownerChatId`);
      res.status(200).json({ ok: true, description: "quickstart missing owner" });
      return;
    }

    const ok = isDelete
      ? await deleteCommandsForChat(ownerChatId)
      : await setCommandsForChat(ownerChatId, commands);

    console.log(
      `📋 Command menu ${method} for quickstart user tg=${ownerChatId} ` +
        `commands=${commands.length} ok=${ok}`,
    );
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("❌ Command menu handler error:", error);
    res.status(500).json({ ok: false, description: "internal error" });
  }
}

// ---------------------------------------------------------------------------
// Exported helpers for container lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Clear per-user command menu when a container is stopped or destroyed.
 */
export async function clearCommandMenuForAssistant(
  ownerTelegramUserId: string,
  assistantBotToken: string | null,
): Promise<void> {
  // Clear Guide Bot per-chat scope
  await deleteCommandsForChat(ownerTelegramUserId);

  // Clear own bot if Advanced user
  if (assistantBotToken && !isQuickStartToken(assistantBotToken)) {
    await deleteCommandsForOwnBot(assistantBotToken);
  }
}
