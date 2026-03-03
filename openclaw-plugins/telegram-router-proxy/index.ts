// OpenClaw Plugin: Telegram Router Proxy
// 让 OpenClaw 通过路由服务发送 Telegram 消息

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';

const FETCH_PATCH_KEY = '__pinaiTelegramRouterFetchPatched__';
const OPENCLAW_GATEWAY_PORT = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);

// Methods blocked entirely (return fake success) to prevent OpenClaw's
// built-in Telegram provider from mutating bot-level settings we control.
const BLOCKED_TELEGRAM_METHODS = new Set([
  'setWebhook',
  'deleteWebhook',
  'getUpdates',
  'setMyCommands',
  'deleteMyCommands',
  'setMyDescription',
  'setMyShortDescription',
  'setMyName',
  'setChatMenuButton',
]);

// Methods that bypass the proxy and go directly to Telegram API.
const PASSTHROUGH_TELEGRAM_METHODS = new Set([
  'getWebhookInfo',
  'getMe',
  'logOut',
  'close'
]);

const plugin = {
  id: 'telegram-router-proxy',
  name: 'Telegram Router Proxy',
  description: 'Proxy Telegram API calls through router service',
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const routerUrl = process.env.TELEGRAM_ROUTER_URL || 'http://host.docker.internal:3001';

    api.logger.info(`Telegram Router Proxy enabled: ${routerUrl}`);
    api.logger.info('TRP_VERSION_20260303A');
    installTelegramFetchProxy(api, routerUrl);
  }
};

function installTelegramFetchProxy(api: OpenClawPluginApi, routerUrl: string) {
  const g = globalThis as typeof globalThis & {
    [FETCH_PATCH_KEY]?: boolean;
  };
  if (g[FETCH_PATCH_KEY]) {
    return;
  }
  if (typeof globalThis.fetch !== 'function') {
    api.logger.warn('Global fetch unavailable, skip Telegram fetch proxy patch');
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const normalizedRouter = routerUrl.replace(/\/+$/, '');

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const patchedGatewayInit = patchCronAddDeliveryAccountId(input, init);
      if (patchedGatewayInit) {
        init = patchedGatewayInit;
      }
      const rawUrl =
        typeof input === 'string' ? input
        : input instanceof URL ? input.toString()
        : input instanceof Request ? input.url
        : null;

      if (rawUrl) {
        const targetUrl = new URL(rawUrl);
        const telegramApiPath = extractTelegramApiPath(targetUrl);
        if (telegramApiPath) {
          const { methodName, botToken } = telegramApiPath;
          if (BLOCKED_TELEGRAM_METHODS.has(methodName)) {
            api.logger.warn(`Blocked Telegram method from OpenClaw: ${methodName}`);
            return new Response(JSON.stringify({ ok: true, result: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (!PASSTHROUGH_TELEGRAM_METHODS.has(methodName)) {
            const proxyUrl = `${normalizedRouter}/api/telegram/${methodName}${targetUrl.search}`;
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
            headers.delete('host');
            headers.delete('authorization');
            headers.set('X-PinAI-Telegram-Bot-Token', botToken);

            const effectiveInit: RequestInit = {
              ...(input instanceof Request ? { method: input.method, body: input.body, redirect: input.redirect } : {}),
              ...init,
              headers
            };
            return await originalFetch(proxyUrl, effectiveInit);
          }
        }
      }
    } catch (error) {
      api.logger.error(`Telegram fetch proxy rewrite failed: ${String(error)}`);
    }
    return await originalFetch(input as RequestInfo, init);
  }) as typeof fetch;

  g[FETCH_PATCH_KEY] = true;
  api.logger.info('Telegram fetch proxy patch installed');
}

function extractTelegramApiPath(url: URL): { methodName: string; botToken: string } | null {
  if (url.hostname !== 'api.telegram.org') {
    return null;
  }
  const match = url.pathname.match(/^\/bot([^/]+)\/([^/?#]+)/);
  if (!match) {
    return null;
  }
  const botToken = match[1] || '';
  const methodName = match[2] || '';
  if (!botToken || !methodName) {
    return null;
  }
  return { methodName, botToken };
}

function patchCronAddDeliveryAccountId(
  input: RequestInfo | URL,
  init?: RequestInit,
): RequestInit | null {
  const rawUrl =
    typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : input instanceof Request ? input.url
    : '';
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

  const method =
    (init?.method || (input instanceof Request ? input.method : 'GET')).trim().toUpperCase();
  if (method !== 'POST') {
    return null;
  }
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
  const contentType = headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  const rawBody = init?.body;
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    return null;
  }
  const bodyText =
    typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody as Uint8Array);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.method !== 'cron.add' || !isRecord(parsed.params)) {
    return null;
  }
  const job = parsed.params;
  if (!isRecord(job.payload) || job.payload.kind !== 'agentTurn') {
    return null;
  }
  if (!isRecord(job.delivery)) {
    return null;
  }
  const delivery = job.delivery;
  const mode = typeof delivery.mode === 'string' ? delivery.mode.trim().toLowerCase() : '';
  if (mode === 'none' || mode === 'webhook') {
    return null;
  }
  if (typeof delivery.accountId === 'string' && delivery.accountId.trim()) {
    return null;
  }
  const sessionKey = typeof job.sessionKey === 'string' ? job.sessionKey : '';
  const inferredAccountId = inferAccountIdFromSessionKey(sessionKey);
  if (!inferredAccountId) {
    return null;
  }

  parsed.params = {
    ...job,
    delivery: {
      ...delivery,
      accountId: inferredAccountId,
    },
  };

  const nextBody = JSON.stringify(parsed);
  return {
    ...(input instanceof Request
      ? { method: input.method, redirect: input.redirect, credentials: input.credentials }
      : {}),
    ...init,
    headers,
    body: nextBody,
  };
}

function isOpenClawGatewayRpc(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback) {
    return false;
  }
  const port = Number.parseInt(url.port || '', 10);
  if (!Number.isFinite(port) || port !== OPENCLAW_GATEWAY_PORT) {
    return false;
  }
  return url.pathname === '/rpc' || url.pathname === '/gateway' || url.pathname === '/gateway/rpc';
}

function inferAccountIdFromSessionKey(sessionKey: string): string | null {
  const raw = (sessionKey || '').trim().toLowerCase();
  if (!raw.startsWith('agent:')) {
    return null;
  }
  const parts = raw.split(':').filter(Boolean);
  if (parts.length < 6) {
    return null;
  }
  const rest = parts.slice(2);
  const head = rest[0];
  if (!head || head === 'main' || head === 'subagent' || head === 'acp') {
    return null;
  }
  const markerIndex = rest.findIndex(
    (part) => part === 'direct' || part === 'dm' || part === 'group' || part === 'channel',
  );
  if (markerIndex < 2) {
    return null;
  }
  const candidate = rest[1]?.trim();
  if (!candidate) {
    return null;
  }
  if (
    candidate === 'direct' ||
    candidate === 'dm' ||
    candidate === 'group' ||
    candidate === 'channel'
  ) {
    return null;
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default plugin;
