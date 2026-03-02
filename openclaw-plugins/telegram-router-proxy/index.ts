// OpenClaw Plugin: Telegram Router Proxy
// 让 OpenClaw 通过路由服务发送 Telegram 消息

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';

const FETCH_PATCH_KEY = '__pinaiTelegramRouterFetchPatched__';

// Methods blocked entirely (return fake success) to prevent OpenClaw's
// built-in Telegram provider from mutating bot-level settings we control.
const BLOCKED_TELEGRAM_METHODS = new Set([
  'setWebhook',
  'deleteWebhook',
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
    api.logger.info('TRP_VERSION_20260302C');
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
      const rawUrl =
        typeof input === 'string' ? input
        : input instanceof URL ? input.toString()
        : input instanceof Request ? input.url
        : null;

      if (rawUrl) {
        const targetUrl = new URL(rawUrl);
        const methodName = extractTelegramMethod(targetUrl);
        if (methodName) {
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

function extractTelegramMethod(url: URL): string | null {
  if (url.hostname !== 'api.telegram.org') {
    return null;
  }
  const match = url.pathname.match(/^\/bot[^/]+\/([^/?#]+)/);
  if (!match) {
    return null;
  }
  return match[1] || null;
}

export default plugin;
