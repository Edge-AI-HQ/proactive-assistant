import express, { type Application, type Request, type Response } from "express";
import { pool } from "../common/db/core.js";
import { config } from "../common/config.js";
import { isGuideBotCommandText } from "./guideCommands.js";
import { getAssistantById } from "../common/db/index.js";
import { hasActiveSubscriptionForService } from "../payment/subscriptionGuard.js";
import { ensureGatewayAssistantReady } from "../gateway/assistant_warmup.js";
import { deriveAssistantWebhookSecret } from "../container/providers/shared/telegram_runtime_secret.js";
import {
  getGoogleConnectionStatus,
  hasGoogleOAuthConnection,
  syncCredentialToContainer,
} from "../google-oauth/service.js";
import {
  setLogContextTelegramIdentity,
  setLogContextTelegramUserId,
} from "../common/requestLogContext.js";

type WebhookSource = "public" | "private";

type ContainerInfo = {
  assistant_id: number;
  container_id: string;
  gateway_token: string;
  assistant_bot_id: string | null;
  runtime_provider: string | null;
  host_port: number | null;
};

type PromptLanguage = "zh" | "en";

type TelegramProxyBodyInfo = {
  chatId?: number;
  contentType: string;
  text?: string;
};

type UserState =
  | { phase: "no_user" }
  | { phase: "no_subscription"; assistantId?: number }
  | {
      phase: "container_starting";
      assistantId: number;
      runtimeStatus: string;
      container?: ContainerInfo;
    }
  | { phase: "running"; assistantId: number; container: ContainerInfo };

const BLOCKED_TG_METHODS = new Set([
  "setmycommands",
  "deletemycommands",
  "setwebhook",
  "deletewebhook",
]);

const WELCOME_MESSAGE_DEDUPE_WINDOW_MS = 45_000;
const welcomeMessageDedupeCache = new Map<number, number>();
const OAUTH_PROMPT_DEDUPE_WINDOW_MS = 20_000;
const oauthPromptDedupeCache = new Map<number, { text: string; sentAt: number }>();
const googleCredentialSyncedRuntimeRef = new Map<number, string>();
const googleCredentialSyncInFlight = new Map<number, Promise<boolean>>();
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export const registerTelegramRouterRoutes = (app: Application): void => {
  app.post("/webhook/telegram", express.json({ limit: "10mb" }), (req, res) => {
    void handleTelegramWebhook(req, res, "public");
  });
  app.post("/webhook/telegram/public", express.json({ limit: "10mb" }), (req, res) => {
    void handleTelegramWebhook(req, res, "public");
  });
  app.post("/webhook/telegram/private", express.json({ limit: "10mb" }), (req, res) => {
    void handleTelegramWebhook(req, res, "private");
  });

  app.all("/api/telegram/file/*", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
    void handleTelegramFileProxy(req, res);
  });
  app.all("/api/telegram/:method", express.raw({ type: "*/*", limit: "50mb" }), (req, res) => {
    void handleTelegramApiProxy(req, res);
  });
};

async function handleTelegramWebhook(req: Request, res: Response, source: WebhookSource): Promise<void> {
  try {
    const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
    const secretToken = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    const expected = config.telegram.webhookSecret.trim();
    const receivedToken = typeof secretToken === "string" ? secretToken.trim() : "";
    if (expected && receivedToken !== expected) {
      const received = receivedToken ? `${receivedToken.slice(0, 8)}...(${receivedToken.length})` : "missing";
      console.error(`❌ Invalid webhook secret (received=${received})`);
      res.status(401).send("Unauthorized");
      return;
    }

    const update = req.body;
    const chatId = extractChatId(update);
    const telegramUsername = extractUpdateUsername(update);
    setLogContextTelegramIdentity(chatId ?? undefined, telegramUsername ?? undefined);
    const fromUser = extractUpdateFromUser(update);
    const text = extractUpdateText(update);
    const telegramDate = extractUpdateDate(update);
    const nowIso = new Date().toISOString();
    console.log(
      `📨 inbound ts=${nowIso} tg_time=${formatUnixTimestamp(telegramDate)} ` +
        `update_id=${update?.update_id ?? "n/a"} chat_id=${chatId ?? "n/a"} ` +
        `source=${source} user=${fromUser ?? "unknown"} text="${truncateForLog(text, 160)}"`,
    );

    if (!chatId) {
      res.status(200).json({ ok: true });
      return;
    }

    if (source === "public" && isBotCommand(update)) {
      const handled = await forwardToGuideBot(update);
      if (!handled) {
        res.status(503).send("Guide bot not initialized");
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (source === "public" && update?.callback_query) {
      const handled = await forwardToGuideBot(update);
      if (!handled) {
        res.status(503).send("Guide bot not initialized");
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    const userStateRaw = await findUserState(chatId);
    const userState = await tryAutoRecoverRuntime(chatId, userStateRaw);
    const stateAssistantId = readAssistantIdFromState(userState);
    const hasActiveSubscription =
      stateAssistantId !== undefined
        ? await hasActiveSubscriptionForService(String(chatId))
        : false;

    if (userState.phase === "no_user") {
      if (source === "public") {
        const handled = await forwardToGuideBot(update);
        if (!handled) {
          res.status(503).send("Guide bot not initialized");
          return;
        }
      } else {
        await sendFallbackMessageBySource(source, chatId, "Welcome! Send /start to begin setting up your AI assistant.");
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (userState.phase === "no_subscription") {
      if (hasActiveSubscription) {
        await sendFallbackMessageBySource(
          source,
          chatId,
          "Your assistant is temporarily unavailable — we're waking it up. Please try again shortly.",
        );
        res.status(200).json({ ok: true });
        return;
      }

      if (source === "public") {
        const handled = await forwardToGuideBot(update);
        if (!handled) {
          res.status(503).send("Guide bot not initialized");
          return;
        }
      } else {
        await sendFallbackMessageBySource(
          source,
          chatId,
          "Your assistant is registered but not yet activated. Please subscribe to start using it.",
        );
      }
      res.status(200).json({ ok: true });
      return;
    }

    // Guard all runtime paths with subscription status.
    // If subscription has ended/refunded, do not forward to assistant runtime
    // and do not show "starting up" fallback.
    if (!hasActiveSubscription) {
      if (source === "public") {
        const handled = await forwardToGuideBot(update);
        if (!handled) {
          res.status(503).send("Guide bot not initialized");
          return;
        }
      } else {
        await sendFallbackMessageBySource(
          source,
          chatId,
          "Your assistant is registered but not yet activated. Please subscribe to start using it.",
        );
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (userState.phase === "container_starting") {
      const oauthPrompted = await tryHandleGoogleOAuthPrompt(
        source,
        chatId,
        text,
        userState.container?.container_id || null,
      );
      if (oauthPrompted) {
        res.status(200).json({ ok: true });
        return;
      }
      if (userState.container) {
        const forwarded = await forwardToOpenClaw(userState.container, update, source);
        if (forwarded) {
          res.status(200).json({ ok: true, forwarded: true });
          return;
        }
      }
      await sendFallbackMessageBySource(
        source,
        chatId,
        "Your assistant is starting up — first launch may take a few minutes. Please try again shortly.",
      );
      res.status(200).json({ ok: true, forwarded: false });
      return;
    }

    const oauthPrompted = await tryHandleGoogleOAuthPrompt(
      source,
      chatId,
      text,
      userState.container.container_id,
    );
    if (oauthPrompted) {
      res.status(200).json({ ok: true });
      return;
    }

    const forwarded = await forwardToOpenClaw(userState.container, update, source);
    if (!forwarded) {
      await sendFallbackMessageBySource(
        source,
        chatId,
        "Your assistant is temporarily unavailable — it may still be starting up. Please try again in a minute or two.",
      );
    }

    res.status(200).json({ ok: true, forwarded });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).send("Internal Server Error");
  }
}

const GOOGLE_WORKSPACE_INTENT_PATTERN = new RegExp(
  [
    "gmail",
    "google\\s*mail",
    "google\\s*workspace",
    "google\\s*calendar",
    "google\\s*drive",
    "google\\s*docs?",
    "google\\s*sheets?",
    "google\\s*slides?",
    "google\\s*forms?",
    "google\\s*meet",
    "google\\s*chat",
    "google\\s*classroom",
    "谷歌\\s*(邮箱|邮件|日历|云盘|网盘|文档|表格|会议)",
  ].join("|"),
  "i",
);

function isGoogleWorkspaceIntent(text: string | null): boolean {
  if (!text) return false;
  return GOOGLE_WORKSPACE_INTENT_PATTERN.test(text);
}

function isGoogleCalendarIntent(text: string | null): boolean {
  if (!text) return false;
  return /(日历|日程|calendar|event|events|meeting|schedule)/i.test(text);
}

export const hasGoogleWorkspaceIntentForTest = (text: string | null): boolean =>
  isGoogleWorkspaceIntent(text);

export const shouldPromptGoogleOAuthForTest = (
  source: WebhookSource,
  text: string | null,
): boolean => source === "public" && isGoogleWorkspaceIntent(text);

export function detectPromptLanguage(text: string | null): PromptLanguage {
  return /[\u3400-\u9fff]/.test(text || "") ? "zh" : "en";
}

export function buildGoogleOAuthPrompt(text: string | null): string {
  const language = detectPromptLanguage(text);
  if (language === "zh") {
    return [
      "你还没有连接 Google Workspace。",
      "↙ 请点击 Telegram 左下角的 PIN AI mini app 按钮。",
      "打开后进入 Data Connectors -> Google 完成授权。",
      "授权完成后，回到这里再发送你刚才的请求。",
    ].join("\n");
  }

  return [
    "Your Google Workspace account is not connected yet.",
    "↙ Open the PIN AI mini app from the bottom-left button in Telegram.",
    "Then go to Data Connectors -> Google to finish authorization.",
    "Then come back here and send the same request again.",
  ].join("\n");
}

function buildGoogleCredentialSyncingPrompt(text: string | null): string {
  const language = detectPromptLanguage(text);
  if (language === "zh") {
    return [
      "Google 已连接，正在同步凭证到你的助手容器。",
      "请等待 10-20 秒后，再发送你刚才的请求。",
    ].join("\n");
  }

  return [
    "Google is connected. We're syncing credentials to your assistant container.",
    "Please wait about 10-20 seconds, then send the same request again.",
  ].join("\n");
}

function buildGoogleCalendarReauthPrompt(text: string | null): string {
  const language = detectPromptLanguage(text);
  if (language === "zh") {
    return [
      "你已连接 Google，但当前授权缺少日历权限。",
      "请在 Telegram 左下角 PIN AI mini app 中进入 Data Connectors -> Google 重新授权，并勾选日历权限。",
      "完成后回到这里重试刚才的请求。",
    ].join("\n");
  }

  return [
    "Google is connected, but the current authorization is missing Calendar permission.",
    "Please open Data Connectors -> Google in the PIN AI mini app (bottom-left in Telegram), reconnect, and grant Calendar access.",
    "Then come back here and retry the same request.",
  ].join("\n");
}

export const buildGoogleCalendarReauthPromptForTest = (
  text: string | null,
): string => buildGoogleCalendarReauthPrompt(text);

export const buildGoogleCredentialSyncingPromptForTest = (
  text: string | null,
): string => buildGoogleCredentialSyncingPrompt(text);

async function ensureGoogleCredentialSync(
  chatId: number,
  runtimeRef: string | null,
): Promise<"ready" | "syncing"> {
  const runtime = (runtimeRef || "").trim();
  if (!runtime) return "ready";

  const alreadySyncedRuntime = googleCredentialSyncedRuntimeRef.get(chatId);
  if (alreadySyncedRuntime === runtime) return "ready";

  const inFlight = googleCredentialSyncInFlight.get(chatId);
  if (inFlight) {
    await inFlight.catch(() => undefined);
    return googleCredentialSyncedRuntimeRef.get(chatId) === runtime
      ? "ready"
      : "syncing";
  }

  const job = syncCredentialToContainer(chatId)
    .then(() => {
      googleCredentialSyncedRuntimeRef.set(chatId, runtime);
      return true;
    })
    .catch((error) => {
      console.warn(`[google-oauth] background sync failed chat_id=${chatId}`, error);
      return false;
    })
    .finally(() => {
      if (googleCredentialSyncInFlight.get(chatId) === job) {
        googleCredentialSyncInFlight.delete(chatId);
      }
    });
  googleCredentialSyncInFlight.set(chatId, job);

  const ok = await job;
  return ok ? "ready" : "syncing";
}

async function tryHandleGoogleOAuthPrompt(
  source: WebhookSource,
  chatId: number,
  text: string | null,
  runtimeRef: string | null,
): Promise<boolean> {
  if (!shouldPromptGoogleOAuthForTest(source, text)) return false;
  const connected = await hasGoogleOAuthConnection(chatId);
  if (connected) {
    const now = Date.now();
    if (isGoogleCalendarIntent(text)) {
      const status = await getGoogleConnectionStatus(chatId).catch(() => null);
      const scopes = (status?.scopes || "").trim();
      if (scopes && !scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
        if (!shouldSuppressGoogleOAuthPrompt(chatId, text, now)) {
          await sendFallbackMessageBySource(
            source,
            chatId,
            buildGoogleCalendarReauthPrompt(text),
          );
        }
        return true;
      }
    }

    const syncState = await ensureGoogleCredentialSync(chatId, runtimeRef);
    if (syncState === "syncing") {
      if (!shouldSuppressGoogleOAuthPrompt(chatId, text, now)) {
        await sendFallbackMessageBySource(
          source,
          chatId,
          buildGoogleCredentialSyncingPrompt(text),
        );
      }
      return true;
    }
    return false;
  }

  const now = Date.now();
  if (shouldSuppressGoogleOAuthPrompt(chatId, text, now)) {
    return true;
  }

  await sendFallbackMessageBySource(source, chatId, buildGoogleOAuthPrompt(text));
  return true;
}

function shouldSuppressGoogleOAuthPrompt(
  chatId: number,
  text: string | null,
  nowMs = Date.now(),
): boolean {
  const normalizedText = (text || '').trim().toLowerCase();
  const previous = oauthPromptDedupeCache.get(chatId);
  oauthPromptDedupeCache.set(chatId, { text: normalizedText, sentAt: nowMs });
  if (!previous) return false;
  return (
    previous.text === normalizedText &&
    nowMs - previous.sentAt < OAUTH_PROMPT_DEDUPE_WINDOW_MS
  );
}

export const shouldSuppressGoogleOAuthPromptForTest = (
  chatId: number,
  text: string | null,
  nowMs = Date.now(),
): boolean => shouldSuppressGoogleOAuthPrompt(chatId, text, nowMs);

async function handleTelegramApiProxy(req: Request, res: Response): Promise<void> {
  try {
    const method = (req.params.method || "").trim();
    const traceId = `tgapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (BLOCKED_TG_METHODS.has(method.toLowerCase())) {
      res.status(200).json({ ok: true, result: true, description: "blocked by router" });
      return;
    }

    const reqMethod = req.method.toUpperCase();
    const hasBody = reqMethod !== "GET" && reqMethod !== "HEAD";
    const body = hasBody ? toBodyBytes(req) : undefined;

    const proxyUrl = new URL(req.originalUrl, "http://localhost");
    const bodyInfo = extractTelegramProxyBodyInfo(proxyUrl, req.headers["content-type"] as string | undefined, body);
    if (bodyInfo.chatId) {
      setLogContextTelegramUserId(bodyInfo.chatId);
    }
    if (shouldSuppressTelegramOutboundMessage(method, bodyInfo)) {
      console.log(
        `🧹 Suppressed duplicate welcome message method=${method} chat_id=${bodyInfo.chatId ?? "n/a"} ` +
          `text="${truncateForLog(bodyInfo.text || "", 120)}"`,
      );
      res.status(200).json({ ok: true, result: true, description: "duplicate welcome suppressed by router" });
      return;
    }
    const userState = bodyInfo.chatId ? await findUserState(bodyInfo.chatId) : null;
    const container = userState?.phase === "running" ? userState.container : null;
    const runtime = container?.container_id ? parseFlyRuntimeRef(container.container_id) : null;

    console.log(
      `🔄 Proxying Telegram API [${traceId}] method=${method} chat_id=${bodyInfo.chatId ?? "n/a"} ` +
        `machine_id=${runtime?.machineId ?? "unknown"} runtime_ref=${container?.container_id ?? "unknown"} ` +
        `content_type=${bodyInfo.contentType} body_bytes=${body?.byteLength ?? 0}`,
    );

    const botToken = resolveProxyBotToken(req);
    const telegramUrl = `https://api.telegram.org/bot${botToken}/${method}${proxyUrl.search}`;
    const outgoingHeaders = new Headers();
    const contentType = req.headers["content-type"] as string | undefined;
    if (contentType) outgoingHeaders.set("content-type", contentType);

    const requestInit: RequestInit = {
      method: reqMethod,
      headers: outgoingHeaders,
    };
    if (body) {
      requestInit.body = body;
    }

    const response = await fetch(telegramUrl, requestInit);

    const result = new Uint8Array(await response.arrayBuffer());
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/json");
    res.send(Buffer.from(result));
  } catch (error) {
    console.error("❌ Telegram API proxy error:", error);
    res.status(500).send("Internal Server Error");
  }
}

async function handleTelegramFileProxy(req: Request, res: Response): Promise<void> {
  try {
    const rawPath = String(req.params[0] || "").replace(/^\/+/, "");
    if (!rawPath) {
      res.status(400).json({ ok: false, description: "missing file path" });
      return;
    }
    const traceId = `tgfile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reqMethod = req.method.toUpperCase();
    const hasBody = reqMethod !== "GET" && reqMethod !== "HEAD";
    const body = hasBody ? toBodyBytes(req) : undefined;
    const proxyUrl = new URL(req.originalUrl, "http://localhost");

    console.log(
      `📦 Proxying Telegram file [${traceId}] method=${reqMethod} path=${rawPath} ` +
        `content_type=${String(req.headers["content-type"] || "none")} body_bytes=${body?.byteLength ?? 0}`,
    );

    const botToken = resolveProxyBotToken(req);
    const telegramUrl = `https://api.telegram.org/file/bot${botToken}/${rawPath}${proxyUrl.search}`;
    const outgoingHeaders = new Headers();
    const contentType = req.headers["content-type"] as string | undefined;
    if (contentType) outgoingHeaders.set("content-type", contentType);

    const requestInit: RequestInit = {
      method: reqMethod,
      headers: outgoingHeaders,
    };
    if (body) {
      requestInit.body = body;
    }

    const response = await fetch(telegramUrl, requestInit);
    const result = new Uint8Array(await response.arrayBuffer());
    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    res.send(Buffer.from(result));
  } catch (error) {
    console.error("❌ Telegram file proxy error:", error);
    res.status(500).send("Internal Server Error");
  }
}

function resolveProxyBotToken(req: Request): string {
  const headerToken = String(req.headers["x-pinai-telegram-bot-token"] || "").trim();
  if (headerToken && /^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/.test(headerToken)) return headerToken;
  return config.telegram.token;
}

async function forwardToGuideBot(update: unknown): Promise<boolean> {
  const bot = (global as any).__telegramBot;
  if (!bot) {
    console.warn("⚠️ Guide bot not initialized");
    return false;
  }
  await bot.handleUpdate(update);
  return true;
}

async function sendFallbackMessageBySource(source: WebhookSource, chatId: number, text: string): Promise<void> {
  if (source === "private") return;
  if (!config.telegram.token?.trim()) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`❌ fallback sendMessage failed status=${response.status} body=${truncateForLog(body, 300)}`);
    }
  } catch (error) {
    console.error("❌ fallback sendMessage network error:", error);
  }
}

async function findUserState(chatId: number): Promise<UserState> {
  try {
    const result = await pool.query<{
      assistant_id: number | null;
      assistant_bot_id: string | null;
      runtime_provider: string | null;
      runtime_ref: string | null;
      runtime_status: string | null;
      host_port: number | null;
      gateway_token: string;
    }>(
      `SELECT
        a.id as assistant_id,
        a.assistant_bot_id,
        r.runtime_provider,
        r.runtime_ref,
        r.status as runtime_status,
        r.host_port,
        u.gateway_token
      FROM users u
      LEFT JOIN assistants a ON a.owner_user_id = u.id
      LEFT JOIN runtime_instances r
        ON r.assistant_id = a.id
        AND r.scope = 'assistant'
      WHERE u.telegram_user_id = $1
      ORDER BY
        CASE WHEN r.status = 'running' THEN 0 ELSE 1 END,
        r.updated_at DESC NULLS LAST,
        a.id DESC
      LIMIT 1`,
      [chatId],
    );

    if (result.rows.length === 0) return { phase: "no_user" };

    const row = result.rows[0];
    if (!row) return { phase: "no_user" };
    if (!row.assistant_id) return { phase: "no_subscription" };
    if (!row.runtime_ref || !row.runtime_status) {
      return { phase: "no_subscription", assistantId: row.assistant_id };
    }

    if (row.runtime_status !== "running") {
      return {
        phase: "container_starting",
        assistantId: row.assistant_id,
        runtimeStatus: row.runtime_status,
        container: {
          assistant_id: row.assistant_id,
          container_id: row.runtime_ref,
          gateway_token: row.gateway_token,
          assistant_bot_id: row.assistant_bot_id,
          runtime_provider: row.runtime_provider,
          host_port: row.host_port ?? null,
        },
      };
    }

    return {
      phase: "running",
      assistantId: row.assistant_id,
      container: {
        assistant_id: row.assistant_id,
        container_id: row.runtime_ref,
        gateway_token: row.gateway_token,
        assistant_bot_id: row.assistant_bot_id,
        runtime_provider: row.runtime_provider,
        host_port: row.host_port ?? null,
      },
    };
  } catch (error) {
    console.error("Database query error:", error);
    return { phase: "no_user" };
  }
}

async function tryAutoRecoverRuntime(chatId: number, state: UserState): Promise<UserState> {
  const assistantId = getAbnormalAssistantId(state);
  if (!assistantId) return state;

  const hasActiveSubscription = await hasActiveSubscriptionForService(String(chatId));
  if (!hasActiveSubscription) return state;

  const assistant = await getAssistantById(assistantId);
  if (!assistant) return state;

  try {
    console.log(
      `🔁 router auto-recover runtime chat_id=${chatId} assistant_id=${assistantId} phase=${state.phase}`,
    );
    await ensureGatewayAssistantReady(assistant);
    return await findUserState(chatId);
  } catch (error) {
    console.warn(
      `⚠️ router auto-recover failed chat_id=${chatId} assistant_id=${assistantId}`,
      error,
    );
    return state;
  }
}

function getAbnormalAssistantId(state: UserState): number | null {
  if (state.phase === "container_starting") return state.assistantId;
  if (state.phase === "no_subscription" && state.assistantId) return state.assistantId;
  return null;
}

function readAssistantIdFromState(state: UserState): number | undefined {
  if (state.phase === "no_subscription") return state.assistantId;
  if (state.phase === "container_starting") return state.assistantId;
  if (state.phase === "running") return state.assistantId;
  return undefined;
}

async function forwardToOpenClaw(container: ContainerInfo, update: unknown, source: WebhookSource): Promise<boolean> {
  const candidateUrls: string[] = [];
  const hasFlyRuntimeRef = container.container_id?.startsWith("fly:");

  if (hasFlyRuntimeRef) {
    candidateUrls.push(...buildFlyWebhookCandidateUrls(container, source));
  }

  if (container.runtime_provider === "docker") {
    candidateUrls.push(...buildDockerWebhookCandidateUrls(container, source));
  }

  if (!candidateUrls.length) {
    candidateUrls.push(...buildFlyWebhookCandidateUrls(container, source));
    candidateUrls.push(...buildDockerWebhookCandidateUrls(container, source));
  }

  if (!candidateUrls.length) return false;

  let lastError: unknown = null;
  const assistantWebhookSecret = deriveAssistantWebhookSecret(
    container.assistant_id,
    container.gateway_token,
    config.apiAuthToken,
  );
  const webhookSecret = assistantWebhookSecret;

  for (const webhookUrl of candidateUrls) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
          "X-PinAI-Source": source,
        },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(20000),
      });

      if (response.ok) return true;

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      const errName = (error as { name?: string } | null)?.name || "";
      const expectedPort = source === "private" ? config.telegramRouter.webhookPort + 1 : config.telegramRouter.webhookPort;
      const isWebhookPort = webhookUrl.includes(`:${expectedPort}/`);
      if (errName === "TimeoutError" && isWebhookPort) {
        console.warn(`⚠️ Forward timeout (assumed accepted) via ${webhookUrl}`);
        return true;
      }
    }
  }

  console.error("❌ Forward failed on all candidate endpoints", lastError);
  return false;
}

function buildDockerWebhookCandidateUrls(container: ContainerInfo, source: WebhookSource): string[] {
  const basePort = container.host_port;
  if (!basePort || basePort <= 0) return [];

  // Convention: gateway = host_port, webhook = host_port + 1, private webhook = host_port + 2
  const webhookHostPort = source === "private" ? basePort + 2 : basePort + 1;
  const path = normalizeWebhookPath(
    source === "private"
      ? `${normalizeWebhookPath(config.telegramRouter.webhookPath)}/private`
      : config.telegramRouter.webhookPath,
  );
  return [`http://127.0.0.1:${webhookHostPort}${path}`];
}

function buildFlyWebhookCandidateUrls(container: ContainerInfo, source: WebhookSource): string[] {
  const runtime = parseFlyRuntimeRef(container.container_id);
  if (!runtime?.machineId) return [];

  const hostCandidates = [
    ...(runtime.privateIp ? [runtime.privateIp] : []),
    `${runtime.machineId}.vm.${config.fly.assistantAppName}.internal`,
  ];
  return buildWebhookCandidateUrls(hostCandidates, source);
}

function buildWebhookCandidateUrls(targetHosts: string[], source: WebhookSource): string[] {
  const path = normalizeWebhookPath(
    source === "private" ? `${normalizeWebhookPath(config.telegramRouter.webhookPath)}/private` : config.telegramRouter.webhookPath,
  );
  const port = source === "private" ? config.telegramRouter.webhookPort + 1 : config.telegramRouter.webhookPort;
  const urls: string[] = [];
  for (const host of targetHosts) {
    urls.push(`http://${formatHostForUrl(host)}:${port}${path}`);
  }
  return [...new Set(urls)];
}

function normalizeWebhookPath(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "/telegram-webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseFlyRuntimeRef(runtimeRef: string): { machineId: string; privateIp?: string } | null {
  if (!runtimeRef) return null;
  if (!runtimeRef.startsWith("fly:")) return { machineId: runtimeRef };
  const payload = runtimeRef.slice(4);
  const [machineId, privateIpRaw] = payload.split("|", 2);
  if (!machineId) return null;
  const privateIp = privateIpRaw?.trim();
  return privateIp ? { machineId, privateIp } : { machineId };
}

function formatHostForUrl(host: string): string {
  if (!host.includes(":")) return host;
  return host.startsWith("[") ? host : `[${host}]`;
}

function toBodyBytes(req: Request): Uint8Array | undefined {
  const body = req.body;
  if (!body) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  return new TextEncoder().encode(JSON.stringify(body));
}

function extractTelegramProxyBodyInfo(
  url: URL,
  contentType: string | undefined,
  body?: Uint8Array,
): TelegramProxyBodyInfo {
  const normalizedType = (contentType || "").toLowerCase();
  let chatId: number | undefined;
  let text: string | undefined;

  if (url.searchParams.has("chat_id")) chatId = parseNumeric(url.searchParams.get("chat_id"));
  if (url.searchParams.has("text")) text = url.searchParams.get("text") || undefined;
  if (url.searchParams.has("caption") && !text) text = url.searchParams.get("caption") || undefined;
  if (!body || body.byteLength === 0) return buildBodyInfo(chatId, normalizedType || "none", text);

  const bodyText = decodeUtf8(body);
  if (!bodyText) return buildBodyInfo(chatId, normalizedType || "binary", text);

  if (normalizedType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const maybeChatId = parseNumeric(parsed.chat_id);
      if (maybeChatId !== undefined) chatId = maybeChatId;
      text = firstNonEmptyString(parsed.text, parsed.caption) || text;
    } catch {
      // ignore
    }
    return buildBodyInfo(chatId, normalizedType, text);
  }

  if (normalizedType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(bodyText);
    const maybeChatId = parseNumeric(params.get("chat_id"));
    if (maybeChatId !== undefined) chatId = maybeChatId;
    text = firstNonEmptyString(params.get("text"), params.get("caption")) || text;
    return buildBodyInfo(chatId, normalizedType, text);
  }

  if (normalizedType.includes("multipart/form-data")) {
    const maybeChatId = parseMultipartChatId(bodyText);
    if (maybeChatId !== undefined) chatId = maybeChatId;
    text = firstNonEmptyString(parseMultipartField(bodyText, "text"), parseMultipartField(bodyText, "caption")) || text;
    return buildBodyInfo(chatId, normalizedType, text);
  }

  return buildBodyInfo(chatId, normalizedType || "text", text);
}

function buildBodyInfo(chatId: number | undefined, contentType: string, text?: string): TelegramProxyBodyInfo {
  return {
    ...(chatId === undefined ? {} : { chatId }),
    ...(text ? { text } : {}),
    contentType,
  };
}

function parseMultipartChatId(raw: string): number | undefined {
  return parseNumeric(parseMultipartField(raw, "chat_id"));
}

function parseMultipartField(raw: string, fieldName: string): string | undefined {
  const marker = `name="${fieldName}"`;
  const idx = raw.indexOf(marker);
  if (idx < 0) return undefined;
  const tail = raw.slice(idx + marker.length);
  const match = tail.match(/\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n$)/);
  if (!match?.[1]) return undefined;
  return match[1].trim();
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function classifyTelegramOutboundMessage(text: string | undefined): "welcome" | null {
  if (!text) return null;
  const normalized = text.toLowerCase();
  const welcomeSignals = [
    /good to see you again/,
    /welcome back/,
    /what should i call you/,
    /how can i help you today/,
    /你想我怎么称呼/,
    /我该怎么称呼/,
    /今天.*帮你/,
  ];
  return welcomeSignals.some((pattern) => pattern.test(normalized)) ? "welcome" : null;
}

export function shouldSuppressTelegramOutboundMessage(
  method: string,
  bodyInfo: TelegramProxyBodyInfo,
  nowMs = Date.now(),
): boolean {
  if (method.toLowerCase() !== "sendmessage") return false;
  if (!bodyInfo.chatId) return false;
  const messageClass = classifyTelegramOutboundMessage(bodyInfo.text);
  if (!messageClass) return false;

  const lastSentAt = welcomeMessageDedupeCache.get(bodyInfo.chatId);
  welcomeMessageDedupeCache.set(bodyInfo.chatId, nowMs);
  return typeof lastSentAt === "number" && nowMs - lastSentAt < WELCOME_MESSAGE_DEDUPE_WINDOW_MS;
}

export function resetTelegramWelcomeDedupeForTest(): void {
  welcomeMessageDedupeCache.clear();
  oauthPromptDedupeCache.clear();
  googleCredentialSyncedRuntimeRef.clear();
  googleCredentialSyncInFlight.clear();
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return undefined;
  }
}

function isBotCommand(update: any): boolean {
  const text: string = update?.message?.text || "";
  return isGuideBotCommandText(text);
}

function extractChatId(update: any): number | null {
  return update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || update?.channel_post?.chat?.id || null;
}

function extractUpdateFromUser(update: any): string | null {
  const from = update?.message?.from || update?.callback_query?.from || update?.channel_post?.from;
  if (!from) return null;
  return from.username || from.first_name || from.last_name || String(from.id || "");
}

function extractUpdateUsername(update: any): string | null {
  const from = update?.message?.from || update?.callback_query?.from || update?.channel_post?.from;
  if (!from || typeof from.username !== "string") return null;
  const username = from.username.trim().replace(/^@+/, "");
  return username || null;
}

function extractUpdateText(update: any): string {
  return update?.message?.text || update?.channel_post?.text || update?.callback_query?.data || "";
}

function extractUpdateDate(update: any): number | undefined {
  const dateValue = update?.message?.date || update?.channel_post?.date || update?.callback_query?.message?.date;
  return parseNumeric(dateValue);
}

function formatUnixTimestamp(unixSec?: number): string {
  if (!unixSec) return "n/a";
  try {
    return new Date(unixSec * 1000).toISOString();
  } catch {
    return "n/a";
  }
}

function truncateForLog(value: string, maxLen: number): string {
  void maxLen;
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact;
}
