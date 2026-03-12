// OpenClaw Plugin: Telegram API Proxy
// Rewrites outbound Telegram API calls to route through the PinAI router service.
// Blocks bot-level mutation methods to prevent OpenClaw's built-in Telegram
// provider from overwriting webhook/command settings we control.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const FETCH_PATCH_KEY = "__pinaiTelegramApiProxyPatched__";

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

function extractTelegramTarget(
  url: URL,
):
  | { kind: "method"; methodName: string; botToken: string }
  | { kind: "file"; filePath: string; botToken: string }
  | null {
  if (url.hostname !== "api.telegram.org") return null;

  const methodMatch = url.pathname.match(/^\/bot([^/]+)\/([^/?#]+)/);
  if (methodMatch) {
    const botToken = methodMatch[1] || "";
    const methodName = methodMatch[2] || "";
    if (!botToken || !methodName) return null;
    return { kind: "method", methodName, botToken };
  }

  const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
  if (!fileMatch) return null;
  const botToken = fileMatch[1] || "";
  const filePath = fileMatch[2] || "";
  if (!botToken || !filePath) return null;
  return { kind: "file", filePath, botToken };
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

function installFetchProxy(api: OpenClawPluginApi, routerUrl: string) {
  const g = globalThis as typeof globalThis & { [FETCH_PATCH_KEY]?: boolean };
  if (g[FETCH_PATCH_KEY]) return;
  if (typeof globalThis.fetch !== "function") {
    api.logger.warn("Global fetch unavailable, skip Telegram API proxy patch");
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const normalizedRouter = routerUrl.replace(/\/+$/, "");

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
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
              api.logger.warn(`Blocked Telegram method: ${methodName}`);
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
              api.logger.info(`Proxied Telegram ${methodName} -> ${resp.status}`);
              return resp;
            } catch (proxyErr) {
              api.logger.error(
                `Proxy fetch failed for ${methodName}: ${String(proxyErr)}`,
              );
              return new Response(
                JSON.stringify({
                  ok: false,
                  description: `proxy unreachable: ${String(proxyErr)}`,
                }),
                { status: 502, headers: { "Content-Type": "application/json" } },
              );
            }
          }
          // File download
          const proxyUrl = `${normalizedRouter}/api/telegram/file/${telegramTarget.filePath}${targetUrl.search}`;
          const effectiveInit = buildProxyInit(input, init, telegramTarget.botToken);
          try {
            return await originalFetch(proxyUrl, effectiveInit);
          } catch (proxyErr) {
            api.logger.error(`Proxy file fetch failed: ${String(proxyErr)}`);
            return new Response(
              JSON.stringify({
                ok: false,
                description: `proxy unreachable: ${String(proxyErr)}`,
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
        }
      }
    } catch (error) {
      api.logger.error(`Telegram API proxy rewrite failed: ${String(error)}`);
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  g[FETCH_PATCH_KEY] = true;
  api.logger.info("Telegram API proxy fetch patch installed");
}

const plugin = {
  id: "telegram-api-proxy",
  name: "Telegram API Proxy",
  description: "Route Telegram API calls through PinAI router service",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const routerUrl =
      process.env.TELEGRAM_ROUTER_URL || "http://host.docker.internal:3000";
    api.logger.info(`Telegram API Proxy enabled: ${routerUrl}`);
    installFetchProxy(api, routerUrl);
  },
};

export default plugin;
