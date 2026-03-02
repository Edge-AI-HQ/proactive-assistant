import { serve } from "bun";
import postgres from "postgres";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
};

const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const WEBHOOK_SECRET = requireEnv("TELEGRAM_WEBHOOK_SECRET");
const DATABASE_URL = requireEnv("DATABASE_URL");
const PORT = Number.parseInt(process.env.PORT || "3001", 10);
const OPENCLAW_TELEGRAM_WEBHOOK_PORT = Number.parseInt(
  process.env.OPENCLAW_TELEGRAM_WEBHOOK_PORT || "8787",
  10,
);
const OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT = Number.parseInt(
  process.env.OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT ||
    String(OPENCLAW_TELEGRAM_WEBHOOK_PORT + 1),
  10,
);
const OPENCLAW_TELEGRAM_WEBHOOK_PATH =
  process.env.OPENCLAW_TELEGRAM_WEBHOOK_PATH || "/telegram-webhook";
const OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PATH =
  process.env.OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PATH ||
  `${normalizeWebhookPath(OPENCLAW_TELEGRAM_WEBHOOK_PATH)}/private`;
const FLY_APP_NAME = process.env.OPENCLAW_FLY_APP_NAME || "pinclaw-api-dev";
const GUIDE_BOT_WEBHOOK_URL = process.env.GUIDE_BOT_WEBHOOK_URL || "";
const BOT_COMMANDS = new Set([
  "start",
  "create_claw_assistant",
  "list_claw_assistant",
  "gateway",
  "help",
]);

const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

console.log("🚀 Telegram Router starting...");
console.log("📡 Bot Token: ✓");
console.log("🔐 Webhook Secret: ✓");
console.log("💾 Database: ✓");

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`📥 ${req.method} ${url.pathname}`);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Telegram webhook 入口（public/private）
    if (
      (url.pathname === "/webhook/telegram" ||
        url.pathname === "/webhook/telegram/public") &&
      req.method === "POST"
    ) {
      return handleTelegramWebhook(req, "public");
    }
    if (url.pathname === "/webhook/telegram/private" && req.method === "POST") {
      return handleTelegramWebhook(req, "private");
    }

    // Telegram API 代理（供 OpenClaw 发送消息）
    if (url.pathname.startsWith("/api/telegram/")) {
      return handleTelegramApiProxy(req, url);
    }

    return new Response("Not Found", { status: 404 });
  },
});

type WebhookSource = "public" | "private";

async function handleTelegramWebhook(req: Request, source: WebhookSource) {
  try {
    // 验证 webhook secret
    const secretToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretToken !== WEBHOOK_SECRET) {
      const received = secretToken
        ? `${secretToken.slice(0, 8)}...(${secretToken.length})`
        : "missing";
      console.error(`❌ Invalid webhook secret (received=${received})`);
      return new Response("Unauthorized", { status: 401 });
    }

    const update = await req.json();

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
      console.log("⚠️  No chat_id found in update");
      return jsonResponse({ ok: true });
    }

    // Forward bot commands to the guide bot (APIs service) for handling
    if (source === "public" && isBotCommand(update) && GUIDE_BOT_WEBHOOK_URL) {
      console.log(`🤖 Forwarding command to guide bot: ${text}`);
      await forwardToGuideBot(update);
      return jsonResponse({ ok: true });
    }

    // Forward callback queries (inline button presses) to guide bot
    if (source === "public" && update.callback_query && GUIDE_BOT_WEBHOOK_URL) {
      console.log(
        `🤖 Forwarding callback_query to guide bot: ${update.callback_query.data}`,
      );
      await forwardToGuideBot(update);
      return jsonResponse({ ok: true });
    }

    const userState = await findUserState(chatId);

    if (userState.phase === "no_user") {
      console.log(`⚠️ No user record for chat_id: ${chatId}`);

      // 如果有引导 bot，转发给它处理（可能是 token 输入等待注册流程）
      if (source === "public" && GUIDE_BOT_WEBHOOK_URL) {
        console.log(`🤖 Forwarding to guide bot for registration handling`);
        await forwardToGuideBot(update);
        return jsonResponse({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "Welcome! Send /start to begin setting up your AI assistant.",
      );
      return jsonResponse({ ok: true });
    }

    if (userState.phase === "no_subscription") {
      console.log(`⚠️ User ${chatId} has assistant but no active container`);

      // 转发给引导 bot，让它处理 token 输入、支付链接等
      if (source === "public" && GUIDE_BOT_WEBHOOK_URL) {
        console.log(
          `🤖 Forwarding to guide bot for subscription/token handling`,
        );
        await forwardToGuideBot(update);
        return jsonResponse({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "Your assistant is registered but not yet activated.\nPlease subscribe to start using it — send /create_claw_assistant for the payment link.",
      );
      return jsonResponse({ ok: true });
    }

    if (userState.phase === "container_starting") {
      if (userState.container) {
        console.log(
          `⚠️ Container for chat_id ${chatId} is ${userState.runtimeStatus} — attempting optimistic forward`,
        );
        const forwarded = await forwardToOpenClaw(
          userState.container,
          update,
          source,
        );
        if (forwarded) {
          return jsonResponse({ ok: true });
        }
      }
      console.log(
        `⚠️ Container for chat_id ${chatId} is starting (status=${userState.runtimeStatus}), forward not possible yet`,
      );
      await sendTelegramMessage(
        chatId,
        "Your assistant is starting up — first launch may take a few minutes. Please try again shortly.",
      );
      return jsonResponse({ ok: true });
    }

    console.log(`✅ Found container:`, userState.container);

    const forwarded = await forwardToOpenClaw(userState.container, update, source);
    if (!forwarded) {
      console.error(`❌ Forward ultimately failed for chat_id=${chatId}`);
      await sendTelegramMessage(
        chatId,
        "Your assistant is temporarily unavailable — it may still be starting up. Please try again in a minute or two.",
      );
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

const BLOCKED_TG_METHODS = new Set([
  "setmycommands",
  "deletemycommands",
  "setwebhook",
  "deletewebhook",
]);

function resolveProxyBotToken(req: Request): string {
  const headerToken = req.headers.get("X-PinAI-Telegram-Bot-Token")?.trim();
  if (headerToken && /^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(headerToken)) {
    return headerToken;
  }
  return TELEGRAM_BOT_TOKEN;
}

async function handleTelegramApiProxy(req: Request, url: URL) {
  try {
    // 提取 Telegram API 方法
    const method = url.pathname.replace("/api/telegram/", "");
    const traceId = `tgapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (BLOCKED_TG_METHODS.has(method.toLowerCase())) {
      console.log(`🚫 Blocked Telegram API method [${traceId}]: ${method}`);
      return new Response(
        JSON.stringify({
          ok: true,
          result: true,
          description: "blocked by router",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const reqMethod = req.method.toUpperCase();
    const hasBody = reqMethod !== "GET" && reqMethod !== "HEAD";
    const body = hasBody ? new Uint8Array(await req.arrayBuffer()) : undefined;
    const bodyInfo = extractTelegramProxyBodyInfo(
      url,
      req.headers.get("content-type"),
      body,
    );
    const userState = bodyInfo.chatId
      ? await findUserState(bodyInfo.chatId)
      : null;
    const container =
      userState?.phase === "running" ? userState.container : null;
    const runtime = container?.container_id
      ? parseFlyRuntimeRef(container.container_id)
      : null;
    const sourceHint =
      req.headers.get("fly-client-ip") ||
      req.headers.get("x-forwarded-for") ||
      req.headers.get("x-real-ip") ||
      "unknown";

    console.log(
      `🔄 Proxying Telegram API [${traceId}] method=${method} chat_id=${bodyInfo.chatId ?? "n/a"} ` +
        `machine_id=${runtime?.machineId ?? "unknown"} runtime_ref=${container?.container_id ?? "unknown"} ` +
        `source=${sourceHint} content_type=${bodyInfo.contentType} body_bytes=${body?.byteLength ?? 0}`,
    );

    const botToken = resolveProxyBotToken(req);
    // 转发到 Telegram API
    const telegramUrl = `https://api.telegram.org/bot${botToken}/${method}${url.search}`;
    const outgoingHeaders = new Headers();
    const contentType = req.headers.get("content-type");
    if (contentType) {
      outgoingHeaders.set("content-type", contentType);
    }
    const response = await fetch(telegramUrl, {
      method: reqMethod,
      headers: outgoingHeaders,
      body: body,
    });

    const result = new Uint8Array(await response.arrayBuffer());
    const responseMeta = parseTelegramApiResponseMeta(response, result);
    console.log(
      `✅ Telegram API response [${traceId}] status=${response.status} ok=${responseMeta.ok ?? "n/a"} ` +
        `result_message_id=${responseMeta.resultMessageId ?? "n/a"} ` +
        `result_chat_id=${responseMeta.resultChatId ?? "n/a"} ` +
        `description=${responseMeta.description ?? "n/a"}`,
    );

    return new Response(result, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    console.error("❌ Telegram API proxy error:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function extractChatId(update: any): number | null {
  return (
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id ||
    update.channel_post?.chat?.id ||
    null
  );
}

function extractUpdateFromUser(update: any): string | null {
  const from =
    update.message?.from ||
    update.callback_query?.from ||
    update.channel_post?.from;
  if (!from) return null;
  return (
    from.username || from.first_name || from.last_name || String(from.id || "")
  );
}

function extractUpdateText(update: any): string {
  return (
    update.message?.text ||
    update.channel_post?.text ||
    update.callback_query?.data ||
    ""
  );
}

function extractUpdateDate(update: any): number | undefined {
  const dateValue =
    update.message?.date ||
    update.channel_post?.date ||
    update.callback_query?.message?.date;
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

type ContainerInfo = {
  container_id: string;
  gateway_token: string;
  assistant_bot_id: string;
  runtime_provider: string;
};

type UserState =
  | { phase: "no_user" }
  | { phase: "no_subscription" }
  | {
      phase: "container_starting";
      runtimeStatus: string;
      container?: ContainerInfo;
    }
  | { phase: "running"; container: ContainerInfo };

async function findUserState(chatId: number): Promise<UserState> {
  try {
    const result = await sql`
      SELECT
        a.id as assistant_id,
        a.assistant_bot_id,
        r.runtime_provider,
        r.runtime_ref,
        r.status as runtime_status,
        u.gateway_token
      FROM users u
      LEFT JOIN assistants a ON a.owner_user_id = u.id
      LEFT JOIN runtime_instances r
        ON r.assistant_id = a.id
        AND r.scope = 'assistant'
      WHERE u.telegram_user_id = ${chatId}
      ORDER BY
        CASE WHEN r.status = 'running' THEN 0 ELSE 1 END,
        r.updated_at DESC NULLS LAST,
        a.id DESC
      LIMIT 1
    `;

    if (result.length === 0) {
      return { phase: "no_user" };
    }

    const row = result[0];

    if (!row.assistant_id) {
      return { phase: "no_subscription" };
    }

    if (!row.runtime_ref || !row.runtime_status) {
      return { phase: "no_subscription" };
    }

    if (row.runtime_status !== "running") {
      const partialContainer: ContainerInfo | undefined = row.runtime_ref
        ? {
            container_id: row.runtime_ref,
            gateway_token: row.gateway_token,
            assistant_bot_id: row.assistant_bot_id,
            runtime_provider: row.runtime_provider,
          }
        : undefined;
      return {
        phase: "container_starting",
        runtimeStatus: row.runtime_status,
        container: partialContainer,
      };
    }

    return {
      phase: "running",
      container: {
        container_id: row.runtime_ref,
        gateway_token: row.gateway_token,
        assistant_bot_id: row.assistant_bot_id,
        runtime_provider: row.runtime_provider,
      },
    };
  } catch (error) {
    console.error("Database query error:", error);
    return { phase: "no_user" };
  }
}

async function forwardToOpenClaw(
  container: any,
  update: any,
  source: WebhookSource,
): Promise<boolean> {
  try {
    const runtime = parseFlyRuntimeRef(container.container_id);
    if (!runtime?.machineId) {
      console.error(`Invalid container_id: ${container.container_id}`);
      return false;
    }

    const hostCandidates = [
      ...(runtime.privateIp ? [runtime.privateIp] : []),
      `${runtime.machineId}.vm.${FLY_APP_NAME}.internal`,
    ];
    const candidateUrls = buildWebhookCandidateUrls(hostCandidates, source);

    console.log(`🎯 Forwarding candidates (source=${source}):`);
    candidateUrls.forEach((url) => console.log(`   - ${url}`));
    console.log(`   Machine ID: ${runtime.machineId}`);
    if (runtime.privateIp) {
      console.log(`   Private IP: ${runtime.privateIp}`);
    }
    console.log(`   Provider: ${container.runtime_provider}`);
    let lastError: unknown = null;

    for (const webhookUrl of candidateUrls) {
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
            "X-PinAI-Source": source,
          },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(20000),
        });

        if (response.ok) {
          console.log(`✅ Forwarded successfully via ${webhookUrl}`);
          return true;
        }

        const text = await response.text().catch(() => "");
        console.warn(
          `⚠️  Forward rejected (${response.status}) at ${webhookUrl}: ${text.slice(0, 200)}`,
        );
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        continue;
      } catch (error) {
        lastError = error;
        const errName = (error as { name?: string } | null)?.name || "";
        // OpenClaw webhook handler may process synchronously and exceed the timeout;
        // treat timeout on the webhook port as "probably accepted" to avoid dropping the update.
        const expectedWebhookPort =
          source === "private"
            ? OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT
            : OPENCLAW_TELEGRAM_WEBHOOK_PORT;
        const isWebhookPort = webhookUrl.includes(
          `:${expectedWebhookPort}/`,
        );
        if (errName === "TimeoutError" && isWebhookPort) {
          console.warn(
            `⚠️ Forward timeout (assumed accepted) via ${webhookUrl}`,
          );
          return true;
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        const errCode = (error as { code?: string })?.code || "";
        console.warn(
          `⚠️  Forward connect error at ${webhookUrl}: ${errCode || errName} ${errMsg.slice(0, 200)}`,
        );
      }
    }

    console.error("❌ Forward failed on all candidate endpoints", lastError);
    return false;
  } catch (error) {
    console.error("❌ Forward error:", error);
    return false;
  }
}

function buildWebhookCandidateUrls(
  targetHosts: string[],
  source: WebhookSource,
): string[] {
  const path = normalizeWebhookPath(
    source === "private"
      ? OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PATH
      : OPENCLAW_TELEGRAM_WEBHOOK_PATH,
  );
  const port =
    source === "private"
      ? OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT
      : OPENCLAW_TELEGRAM_WEBHOOK_PORT;
  const urls: string[] = [];
  for (const host of targetHosts) {
    const urlHost = formatHostForUrl(host);
    urls.push(`http://${urlHost}:${port}${path}`);
  }
  return [...new Set(urls)];
}

function normalizeWebhookPath(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "/telegram-webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseFlyRuntimeRef(
  runtimeRef: string,
): { machineId: string; privateIp?: string } | null {
  if (!runtimeRef) return null;
  if (!runtimeRef.startsWith("fly:")) {
    return { machineId: runtimeRef };
  }

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

function extractTelegramProxyBodyInfo(
  url: URL,
  contentType: string | null,
  body?: Uint8Array,
): { chatId?: number; contentType: string } {
  const normalizedType = (contentType || "").toLowerCase();
  let chatId: number | undefined;

  if (url.searchParams.has("chat_id")) {
    chatId = parseNumeric(url.searchParams.get("chat_id"));
  }

  if (!body || body.byteLength === 0) {
    return { chatId, contentType: normalizedType || "none" };
  }

  const bodyText = decodeUtf8(body);
  if (!bodyText) {
    return { chatId, contentType: normalizedType || "binary" };
  }

  if (normalizedType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const maybeChatId = parseNumeric(parsed.chat_id);
      if (maybeChatId !== undefined) {
        chatId = maybeChatId;
      }
    } catch {}
    return { chatId, contentType: normalizedType };
  }

  if (normalizedType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(bodyText);
    const maybeChatId = parseNumeric(params.get("chat_id"));
    if (maybeChatId !== undefined) {
      chatId = maybeChatId;
    }
    return { chatId, contentType: normalizedType };
  }

  if (normalizedType.includes("multipart/form-data")) {
    const maybeChatId = parseMultipartChatId(bodyText);
    if (maybeChatId !== undefined) {
      chatId = maybeChatId;
    }
    return { chatId, contentType: normalizedType };
  }

  return { chatId, contentType: normalizedType || "text" };
}

function parseTelegramApiResponseMeta(
  response: Response,
  body: Uint8Array,
): {
  ok?: boolean;
  resultMessageId?: number;
  resultChatId?: number;
  description?: string;
} {
  const contentType = (
    response.headers.get("content-type") || ""
  ).toLowerCase();
  if (!contentType.includes("application/json")) {
    return {};
  }

  const text = decodeUtf8(body);
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number; chat?: { id?: number } };
    };
    return {
      ok: parsed.ok,
      resultMessageId: parseNumeric(parsed.result?.message_id),
      resultChatId: parseNumeric(parsed.result?.chat?.id),
      description: parsed.description,
    };
  } catch {
    return {};
  }
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
  const text: string = update.message?.text || "";
  if (!text.startsWith("/")) return false;
  const command = text.slice(1).split(/[\s@]/)[0]?.toLowerCase();
  return BOT_COMMANDS.has(command || "");
}

async function forwardToGuideBot(update: any): Promise<void> {
  try {
    const response = await fetch(GUIDE_BOT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`⚠️ Guide bot returned ${response.status}`);
    }
  } catch (error) {
    console.error("❌ Forward to guide bot failed:", error);
  }
}

async function sendTelegramMessage(chatId: number, text: string) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
  } catch (error) {
    console.error("Send message error:", error);
  }
}

function jsonResponse(data: any) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}

console.log(`✅ Telegram Router listening on http://localhost:${PORT}`);
