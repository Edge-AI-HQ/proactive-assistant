// OpenClaw Plugin: Telegram Router Proxy
// 让 OpenClaw 通过路由服务发送 Telegram 消息

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const FETCH_PATCH_KEY = "__pinaiTelegramRouterFetchPatched__";
const LITELLM_STREAM_ADAPTER_HEADER = "x-pinai-litellm-stream-adapter";
const OPENCLAW_GATEWAY_PORT = Number.parseInt(
  process.env.OPENCLAW_GATEWAY_PORT || "18789",
  10,
);

// Methods blocked entirely (return fake success) to prevent OpenClaw's
// built-in Telegram provider from mutating bot-level settings we control.
const BLOCKED_TELEGRAM_METHODS = new Set([
  "setWebhook",
  "deleteWebhook",
  "getUpdates",
  "setMyCommands",
  "deleteMyCommands",
  "setMyDescription",
  "setMyShortDescription",
  "setMyName",
  "setChatMenuButton",
]);

// Methods that bypass the proxy and go directly to Telegram API.
const PASSTHROUGH_TELEGRAM_METHODS = new Set([
  "getWebhookInfo",
  "logOut",
  "close",
]);

const plugin = {
  id: "telegram-router-proxy",
  name: "Telegram Router Proxy",
  description: "Proxy Telegram API calls through router service",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const routerUrl =
      process.env.TELEGRAM_ROUTER_URL || "http://host.docker.internal:3000";

    api.logger.info(`Telegram Router Proxy enabled: ${routerUrl}`);
    api.logger.info("TRP_VERSION_20260311_SKIP_DEVICE_PAIRING");
    installTelegramFetchProxy(api, routerUrl);
    disableDeviceIdentityForLoopbackCalls(api);
  },
};

function installTelegramFetchProxy(api: OpenClawPluginApi, routerUrl: string) {
  const g = globalThis as typeof globalThis & {
    [FETCH_PATCH_KEY]?: boolean;
  };
  if (g[FETCH_PATCH_KEY]) {
    return;
  }
  if (typeof globalThis.fetch !== "function") {
    api.logger.warn(
      "Global fetch unavailable, skip Telegram fetch proxy patch",
    );
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const normalizedRouter = routerUrl.replace(/\/+$/, "");

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const patchedGatewayInit = await patchCronAddDeliveryAccountId(
        input,
        init,
        api,
      );
      if (patchedGatewayInit) {
        init = patchedGatewayInit;
      }
      const patchedLiteLLMInit = await patchLiteLLMVisionStreamOff(
        input,
        init,
        api,
      );
      if (patchedLiteLLMInit) {
        init = patchedLiteLLMInit;
      }
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : null;

      if (rawUrl) {
        const targetUrl = new URL(rawUrl);
        const telegramTarget = extractTelegramTarget(targetUrl);
        if (telegramTarget) {
          if (telegramTarget.kind === "method") {
            const { methodName, botToken } = telegramTarget;
            if (BLOCKED_TELEGRAM_METHODS.has(methodName)) {
              api.logger.warn(
                `Blocked Telegram method from OpenClaw: ${methodName}`,
              );
              return new Response(JSON.stringify({ ok: true, result: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            if (PASSTHROUGH_TELEGRAM_METHODS.has(methodName)) {
              return await originalFetch(input as RequestInfo, init);
            }
            const proxyUrl = `${normalizedRouter}/api/telegram/${methodName}${targetUrl.search}`;
            const effectiveInit = buildProxyInit(input, init, botToken);
            try {
              const resp = await originalFetch(proxyUrl, effectiveInit);
              api.logger.info(
                `Proxied Telegram method ${methodName} -> ${resp.status}`,
              );
              return resp;
            } catch (proxyErr) {
              api.logger.error(
                `Proxy fetch failed for ${methodName} via ${normalizedRouter}: ${String(proxyErr)}`,
              );
              return new Response(
                JSON.stringify({
                  ok: false,
                  description: `proxy unreachable: ${String(proxyErr)}`,
                }),
                {
                  status: 502,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          }
          const proxyUrl = `${normalizedRouter}/api/telegram/file/${telegramTarget.filePath}${targetUrl.search}`;
          const effectiveInit = buildProxyInit(
            input,
            init,
            telegramTarget.botToken,
          );
          try {
            return await originalFetch(proxyUrl, effectiveInit);
          } catch (proxyErr) {
            api.logger.error(
              `Proxy file fetch failed via ${normalizedRouter}: ${String(proxyErr)}`,
            );
            return new Response(
              JSON.stringify({
                ok: false,
                description: `proxy unreachable: ${String(proxyErr)}`,
              }),
              {
                status: 502,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }
      }
    } catch (error) {
      api.logger.error(`Telegram fetch proxy rewrite failed: ${String(error)}`);
    }
    const { nextInit, shouldAdaptLiteLLMStream } =
      consumeLiteLLMStreamAdapterMarker(input, init);
    const response = await originalFetch(input as RequestInfo, nextInit);
    if (shouldAdaptLiteLLMStream) {
      return await adaptLiteLLMNonStreamResponseToSse(response, api);
    }
    return response;
  }) as typeof fetch;

  g[FETCH_PATCH_KEY] = true;
  api.logger.info("Telegram fetch proxy patch installed");
}

function buildProxyInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  botToken: string,
): RequestInit {
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  headers.delete("host");
  headers.delete("authorization");
  headers.set("X-PinAI-Telegram-Bot-Token", botToken);
  return {
    ...(input instanceof Request
      ? { method: input.method, body: input.body, redirect: input.redirect }
      : {}),
    ...init,
    headers,
  };
}

function extractTelegramTarget(
  url: URL,
):
  | { kind: "method"; methodName: string; botToken: string }
  | { kind: "file"; filePath: string; botToken: string }
  | null {
  if (url.hostname !== "api.telegram.org") {
    return null;
  }
  const methodMatch = url.pathname.match(/^\/bot([^/]+)\/([^/?#]+)/);
  if (methodMatch) {
    const botToken = methodMatch[1] || "";
    const methodName = methodMatch[2] || "";
    if (!botToken || !methodName) {
      return null;
    }
    return { kind: "method", methodName, botToken };
  }
  const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
  if (!fileMatch) {
    return null;
  }
  const botToken = fileMatch[1] || "";
  const filePath = fileMatch[2] || "";
  if (!botToken || !filePath) {
    return null;
  }
  return { kind: "file", filePath, botToken };
}

async function patchCronAddDeliveryAccountId(
  input: RequestInfo | URL,
  init?: RequestInit,
  api?: OpenClawPluginApi,
): Promise<RequestInit | null> {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : "";
  if (!rawUrl) {
    return null;
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isOpenClawGatewayRpc(targetUrl)) {
    return null;
  }

  const method = (
    init?.method || (input instanceof Request ? input.method : "GET")
  )
    .trim()
    .toUpperCase();
  if (method !== "POST") {
    return null;
  }
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const contentType = headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  let bodyText = "";
  const rawBody = init?.body;
  if (typeof rawBody === "string") {
    bodyText = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = "";
    }
  }
  if (!bodyText) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.method !== "cron.add" || !isRecord(parsed.params)) {
    return null;
  }
  const job = parsed.params;
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const mode =
    typeof delivery.mode === "string" ? delivery.mode.trim().toLowerCase() : "";
  if (mode === "none" || mode === "webhook") {
    return null;
  }
  const sessionKey =
    typeof job.sessionKey === "string"
      ? job.sessionKey
      : isRecord(job.payload) && typeof job.payload.sessionKey === "string"
        ? job.payload.sessionKey
        : "";
  const inferredAccountId = inferAccountIdFromSessionKey(sessionKey);
  const inferredPeerId = inferPeerIdFromSessionKey(sessionKey);

  const existingTo = typeof delivery.to === "string" ? delivery.to.trim() : "";
  const existingAccountId =
    typeof delivery.accountId === "string" && delivery.accountId.trim()
      ? delivery.accountId.trim().toLowerCase()
      : "";

  // Determine targets: prioritize inferred, fallback to existing, then use safe defaults
  const hasInferredTarget = inferredAccountId || inferredPeerId;
  const hasExistingTarget = existingTo || existingAccountId;

  if (!hasInferredTarget && !hasExistingTarget) {
    // No target info at all - set safe defaults to bypass pairing requirement
    // Use 'last' channel which sends to the most recent chat context
    api?.logger.info(
      '[cron.add patch] No target info, using "last" channel to bypass pairing',
    );
    parsed.params = {
      ...job,
      delivery: {
        ...delivery,
        mode: "announce",
        channel: "last",
        accountId: "default",
      },
    };
    return {
      ...(input instanceof Request
        ? {
            method: input.method,
            redirect: input.redirect,
            credentials: input.credentials,
          }
        : {}),
      ...init,
      headers,
      body: JSON.stringify(parsed),
    };
  }

  const inferredTo = inferredPeerId ? `telegram:${inferredPeerId}` : "";
  const nextTo = inferredTo || existingTo;
  const nextMode =
    typeof delivery.mode === "string" && delivery.mode.trim()
      ? delivery.mode
      : "announce";
  const nextChannel =
    typeof delivery.channel === "string" && delivery.channel.trim()
      ? delivery.channel
      : "telegram";
  const nextAccountId = inferredAccountId || existingAccountId || undefined;

  parsed.params = {
    ...job,
    delivery: {
      ...delivery,
      mode: nextMode,
      channel: nextChannel,
      ...(nextTo ? { to: nextTo } : {}),
      ...(nextAccountId ? { accountId: nextAccountId } : {}),
    },
  };
  api?.logger.info(
    `[cron.add patch] sessionKey=${sessionKey || "n/a"} accountId=${nextAccountId || "n/a"} to=${nextTo || "n/a"}`,
  );

  const nextBody = JSON.stringify(parsed);
  return {
    ...(input instanceof Request
      ? {
          method: input.method,
          redirect: input.redirect,
          credentials: input.credentials,
        }
      : {}),
    ...init,
    headers,
    body: nextBody,
  };
}

async function patchLiteLLMVisionStreamOff(
  input: RequestInfo | URL,
  init?: RequestInit,
  api?: OpenClawPluginApi,
): Promise<RequestInit | null> {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : "";
  if (!rawUrl) {
    return null;
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isLiteLLMChatCompletions(targetUrl)) {
    return null;
  }
  const method = (
    init?.method || (input instanceof Request ? input.method : "GET")
  )
    .trim()
    .toUpperCase();
  if (method !== "POST") {
    return null;
  }
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const contentType = headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  let bodyText = "";
  const rawBody = init?.body;
  if (typeof rawBody === "string") {
    bodyText = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = "";
    }
  }
  if (!bodyText) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.stream !== true || !hasImageMessages(parsed.messages)) {
    return null;
  }
  parsed.stream = false;
  headers.set(LITELLM_STREAM_ADAPTER_HEADER, "1");
  const nextBody = JSON.stringify(parsed);
  api?.logger.info("[litellm patch] disable stream for vision request");
  return {
    ...(input instanceof Request
      ? {
          method: input.method,
          redirect: input.redirect,
          credentials: input.credentials,
        }
      : {}),
    ...init,
    headers,
    body: nextBody,
  };
}

function isLiteLLMChatCompletions(url: URL): boolean {
  return /\/(v1\/)?chat\/completions$/.test(url.pathname);
}

function hasImageMessages(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const type = String(part.type || "").toLowerCase();
      if (type === "image_url" || type === "input_image" || type === "image") {
        return true;
      }
      if (isRecord(part.image_url) || typeof part.image === "string") {
        return true;
      }
    }
  }
  return false;
}

function consumeLiteLLMStreamAdapterMarker(
  input: RequestInfo | URL,
  init?: RequestInit,
): { nextInit: RequestInit | undefined; shouldAdaptLiteLLMStream: boolean } {
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : {}),
  );
  const marker = headers.get(LITELLM_STREAM_ADAPTER_HEADER) === "1";
  if (!marker) {
    return { nextInit: init, shouldAdaptLiteLLMStream: false };
  }
  headers.delete(LITELLM_STREAM_ADAPTER_HEADER);
  const nextInit: RequestInit = {
    ...(input instanceof Request
      ? { method: input.method, body: input.body, redirect: input.redirect }
      : {}),
    ...init,
    headers,
  };
  return { nextInit, shouldAdaptLiteLLMStream: true };
}

async function adaptLiteLLMNonStreamResponseToSse(
  response: Response,
  api?: OpenClawPluginApi,
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("text/event-stream")) {
    return response;
  }
  const raw = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(raw, {
      status: response.status,
      headers: response.headers,
    });
  }
  const content = extractLiteLLMMessageText(parsed);
  if (!content) {
    return new Response(raw, {
      status: response.status,
      headers: response.headers,
    });
  }
  const created = Math.floor(Date.now() / 1000);
  const id =
    typeof parsed.id === "string" && parsed.id.trim()
      ? parsed.id.trim()
      : `chatcmpl_${Date.now()}`;
  const model = typeof parsed.model === "string" ? parsed.model : "";
  const firstChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
  const lastChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  const sse =
    `data: ${JSON.stringify(firstChunk)}\n\n` +
    `data: ${JSON.stringify(lastChunk)}\n\n` +
    "data: [DONE]\n\n";
  api?.logger.info("[litellm patch] adapted non-stream completion to SSE");
  return new Response(sse, {
    status: response.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function extractLiteLLMMessageText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  if (!choices.length || !isRecord(choices[0])) {
    return "";
  }
  const message = isRecord(choices[0].message) ? choices[0].message : null;
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text) {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function isOpenClawGatewayRpc(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) {
    return false;
  }
  const port = Number.parseInt(url.port || "", 10);
  if (!Number.isFinite(port) || port !== OPENCLAW_GATEWAY_PORT) {
    return false;
  }
  return (
    url.pathname === "/rpc" ||
    url.pathname === "/gateway" ||
    url.pathname === "/gateway/rpc"
  );
}

function inferAccountIdFromSessionKey(sessionKey: string): string | null {
  const raw = (sessionKey || "").trim().toLowerCase();
  if (raw === "agent:main:main") {
    return "private";
  }
  if (/^telegram:\d+$/.test(raw)) {
    return "private";
  }
  if (!raw.startsWith("agent:")) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  const rest = parts.slice(2);
  if (rest.length < 3) {
    return null;
  }
  const markerIndex = rest.findIndex(
    (part) =>
      part === "direct" ||
      part === "dm" ||
      part === "group" ||
      part === "channel",
  );
  if (markerIndex <= 0) {
    return null;
  }
  const segment = rest.slice(0, markerIndex);
  const candidate = segment[segment.length - 1]?.trim();
  if (!candidate) {
    return null;
  }
  if (candidate === "public") {
    return "default";
  }
  if (candidate === "default" || candidate === "private") {
    return candidate;
  }
  return null;
}

function inferPeerIdFromSessionKey(sessionKey: string): string | null {
  const raw = (sessionKey || "").trim().toLowerCase();
  const tgMatch = raw.match(/^telegram:(\d+)$/);
  if (tgMatch?.[1]) {
    return tgMatch[1];
  }
  if (!raw.startsWith("agent:")) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  const markerIndex = parts.findIndex(
    (part) =>
      part === "direct" ||
      part === "dm" ||
      part === "group" ||
      part === "channel",
  );
  if (markerIndex < 0 || markerIndex + 1 >= parts.length) {
    return null;
  }
  const candidate = parts[markerIndex + 1]?.trim() || "";
  return /^\d+$/.test(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Disable device identity for loopback gateway calls.
 * This allows cron and other internal services to bypass pairing requirements.
 *
 * Strategy: Patch the GatewayClient constructor to skip deviceIdentity when
 * connecting to loopback gateway with token auth.
 */
function disableDeviceIdentityForLoopbackCalls(api: OpenClawPluginApi) {
  // Set environment flag to signal we want to skip device identity for local calls
  process.env.OPENCLAW_SKIP_DEVICE_PAIRING = "1";

  api.logger.info(
    "[device-pairing] Set OPENCLAW_SKIP_DEVICE_PAIRING=1 to bypass pairing",
  );
  api.logger.info(
    "[device-pairing] Cron and internal tools should work without pairing",
  );

  // The key insight: with gateway.controlUi.dangerouslyDisableDeviceAuth: true,
  // the gateway server will accept connections without device identity when
  // shared token auth succeeds. We just need to prevent the client from
  // sending device identity in the first place.
  //
  // Unfortunately, OpenClaw's callGateway() always calls loadOrCreateDeviceIdentity().
  // The only way to bypass this is through gateway server-side config, which we've
  // already set: dangerouslyDisableDeviceAuth: true should allow token-only auth.
}

export default plugin;
