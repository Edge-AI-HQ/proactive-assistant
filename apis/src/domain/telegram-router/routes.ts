import express, { type Application, type Request, type Response } from "express";
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { pool } from "../common/db/core.js";
import { config } from "../common/config.js";
import { isGuideBotCommandText } from "./guideCommands.js";
import { getAssistantById } from "../common/db/index.js";
import { hasActiveSubscriptionForService } from "../payment/subscriptionGuard.js";
import { ensureGatewayAssistantReady } from "../gateway/assistant_warmup.js";
import { deriveAssistantWebhookSecret } from "../container/providers/shared/telegram_runtime_secret.js";
import { syncCredentialToContainer } from "../google-oauth/service.js";

type WebhookSource = "public" | "private";

type ContainerInfo = {
  assistant_id: number;
  container_id: string;
  gateway_token: string;
  assistant_bot_id: string | null;
  runtime_provider: string | null;
  host_port: number | null;
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
      const hasActiveSubscription =
        userState.assistantId !== undefined
          ? await hasActiveSubscriptionForService(String(chatId))
          : false;
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

    if (userState.phase === "container_starting") {
      const oauthPrompted = await tryHandleGoogleOAuthPrompt(source, chatId, text);
      if (oauthPrompted) {
        res.status(200).json({ ok: true });
        return;
      }
      if (userState.container) {
        const forwarded = await forwardToOpenClaw(userState.container, update, source);
        if (forwarded) {
          res.status(200).json({ ok: true });
          return;
        }
      }
      await sendFallbackMessageBySource(
        source,
        chatId,
        "Your assistant is starting up — first launch may take a few minutes. Please try again shortly.",
      );
      res.status(200).json({ ok: true });
      return;
    }

    const oauthPrompted = await tryHandleGoogleOAuthPrompt(source, chatId, text);
    if (oauthPrompted) {
      res.status(200).json({ ok: true });
      return;
    }

    const mailHandled = await tryHandleGmailListIntentWithRouter(
      source,
      chatId,
      text,
      userState.container.container_id,
    );
    if (mailHandled) {
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

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).send("Internal Server Error");
  }
}

const MAIL_INTENT_PATTERN =
  /(邮件|邮箱|gmail|mailbox|inbox|收件箱|未读|最近\d*封|latest\s*\d+\s*(emails?|mails?))/i;
const LATEST_MAIL_INTENT_PATTERN =
  /(最近|最新|latest)\s*(\d{1,2})?\s*(封)?\s*(邮件|邮箱|emails?|mails?)/i;

function isMailIntent(text: string | null): boolean {
  if (!text) return false;
  return MAIL_INTENT_PATTERN.test(text);
}

function buildGoogleManageUrl(telegramUserId: number): string {
  const base = (config.publicBaseUrl || "").trim().replace(/\/+$/, "");
  return `${base}/google/manage?telegram_user_id=${telegramUserId}`;
}

async function hasGoogleOAuthCredential(telegramUserId: number): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM google_oauth_credentials
       WHERE telegram_user_id = $1
         AND (
           COALESCE(length(refresh_token_enc), 0) > 0
           OR COALESCE(length(access_token_enc), 0) > 0
         )
     ) AS exists`,
    [telegramUserId],
  );
  return Boolean(result.rows[0]?.exists);
}

async function tryHandleGoogleOAuthPrompt(
  source: WebhookSource,
  chatId: number,
  text: string | null,
): Promise<boolean> {
  if (!isMailIntent(text)) return false;
  const connected = await hasGoogleOAuthCredential(chatId);
  if (connected) {
    try {
      await syncCredentialToContainer(chatId);
      return false;
    } catch (error) {
      const manageUrl = buildGoogleManageUrl(chatId);
      await sendFallbackMessageBySource(
        source,
        chatId,
        [
          "检测到你已授权 Google，但凭据还没成功下发到助理容器。",
          "请打开下方页面后点击“下发 gws 凭据到容器”重试：",
          manageUrl,
          "",
          `错误: ${(error as Error).message}`,
        ].join("\n"),
      );
      return true;
    }
  }

  const manageUrl = buildGoogleManageUrl(chatId);
  await sendFallbackMessageBySource(
    source,
    chatId,
    [
      "你还没有连接 Google 邮箱，先完成一次授权：",
      manageUrl,
      "",
      "授权完成后回到这里再发：给我看最近10封邮件",
    ].join("\n"),
  );
  return true;
}

function parseLatestMailCount(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(LATEST_MAIL_INTENT_PATTERN);
  if (!m) return null;
  const raw = (m[2] || "").trim();
  if (!raw) return 10;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(n, 20);
}

async function runCommandInContainer(
  containerId: string,
  cmd: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const docker = new Docker();
  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: false, stdin: false });
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdoutStream.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderrStream.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  docker.modem.demuxStream(stream, stdoutStream, stderrStream);
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const inspect = await exec.inspect();
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  return {
    exitCode: inspect.ExitCode ?? null,
    stdout,
    stderr,
  };
}

type GmailHeader = { name?: string; value?: string };
type GmailMessageGet = {
  id?: string;
  snippet?: string;
  payload?: {
    headers?: GmailHeader[];
  };
};

function readHeader(headers: GmailHeader[] | undefined, key: string): string {
  if (!Array.isArray(headers)) return "";
  const found = headers.find((h) => String(h?.name || "").toLowerCase() === key.toLowerCase());
  return String(found?.value || "").trim();
}

async function fetchLatestMailSummariesFromContainer(
  containerId: string,
  maxResults: number,
): Promise<Array<{ from: string; subject: string; date: string }>> {
  const listCmd = [
    "gws",
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({ userId: "me", maxResults }),
  ];
  const listed = await runCommandInContainer(containerId, listCmd);
  if ((listed.exitCode ?? 1) !== 0) {
    throw new Error(`gws list failed: ${listed.stdout || listed.stderr}`);
  }

  const listJson = JSON.parse(listed.stdout) as { messages?: Array<{ id?: string }> };
  const ids = (listJson.messages || [])
    .map((m) => String(m.id || "").trim())
    .filter(Boolean)
    .slice(0, maxResults);
  const rows: Array<{ from: string; subject: string; date: string }> = [];

  for (const id of ids) {
    const getCmd = [
      "gws",
      "gmail",
      "users",
      "messages",
      "get",
      "--params",
      JSON.stringify({
        userId: "me",
        id,
        format: "full",
      }),
    ];
    const got = await runCommandInContainer(containerId, getCmd);
    if ((got.exitCode ?? 1) !== 0) continue;

    const detail = JSON.parse(got.stdout) as GmailMessageGet;
    const headers = detail.payload?.headers || [];
    const snippet = String(detail.snippet || "").trim();
    rows.push({
      from: readHeader(headers, "From") || "(未知发件人)",
      subject: readHeader(headers, "Subject") || snippet || "(无主题)",
      date: readHeader(headers, "Date") || "",
    });
  }

  return rows;
}

async function tryHandleGmailListIntentWithRouter(
  source: WebhookSource,
  chatId: number,
  text: string | null,
  containerId: string,
): Promise<boolean> {
  const count = parseLatestMailCount(text);
  if (!count) return false;

  try {
    await syncCredentialToContainer(chatId);
  } catch (error) {
    const manageUrl = buildGoogleManageUrl(chatId);
    await sendFallbackMessageBySource(
      source,
      chatId,
      [
        "Google 授权存在，但凭据未成功下发到容器。",
        "请打开管理页重试“下发 gws 凭据到容器”：",
        manageUrl,
        "",
        `错误: ${(error as Error).message}`,
      ].join("\n"),
    );
    return true;
  }

  try {
    const rows = await fetchLatestMailSummariesFromContainer(containerId, count);
    if (!rows.length) {
      await sendFallbackMessageBySource(source, chatId, "邮箱里没有读到可展示的邮件。");
      return true;
    }

    const lines = rows.map((row, idx) => `${idx + 1}. ${row.subject}\n   发件人: ${row.from}${row.date ? `\n   时间: ${row.date}` : ""}`);
    await sendFallbackMessageBySource(source, chatId, [`最新 ${rows.length} 封邮件：`, ...lines].join("\n\n"));
    return true;
  } catch (error) {
    await sendFallbackMessageBySource(
      source,
      chatId,
      `读取 Gmail 失败：${(error as Error).message}\n请稍后重试，或重新授权后再试。`,
    );
    return true;
  }
}

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
): { chatId?: number; contentType: string } {
  const normalizedType = (contentType || "").toLowerCase();
  let chatId: number | undefined;

  if (url.searchParams.has("chat_id")) chatId = parseNumeric(url.searchParams.get("chat_id"));
  if (!body || body.byteLength === 0) return buildBodyInfo(chatId, normalizedType || "none");

  const bodyText = decodeUtf8(body);
  if (!bodyText) return buildBodyInfo(chatId, normalizedType || "binary");

  if (normalizedType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const maybeChatId = parseNumeric(parsed.chat_id);
      if (maybeChatId !== undefined) chatId = maybeChatId;
    } catch {
      // ignore
    }
    return buildBodyInfo(chatId, normalizedType);
  }

  if (normalizedType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(bodyText);
    const maybeChatId = parseNumeric(params.get("chat_id"));
    if (maybeChatId !== undefined) chatId = maybeChatId;
    return buildBodyInfo(chatId, normalizedType);
  }

  if (normalizedType.includes("multipart/form-data")) {
    const maybeChatId = parseMultipartChatId(bodyText);
    if (maybeChatId !== undefined) chatId = maybeChatId;
    return buildBodyInfo(chatId, normalizedType);
  }

  return buildBodyInfo(chatId, normalizedType || "text");
}

function buildBodyInfo(chatId: number | undefined, contentType: string): { chatId?: number; contentType: string } {
  if (chatId === undefined) return { contentType };
  return { chatId, contentType };
}

function parseMultipartChatId(raw: string): number | undefined {
  const marker = 'name="chat_id"';
  const idx = raw.indexOf(marker);
  if (idx < 0) return undefined;
  const tail = raw.slice(idx + marker.length);
  const match = tail.match(/\r?\n\r?\n([\-0-9]+)/);
  if (!match) return undefined;
  return parseNumeric(match[1]);
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
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}
