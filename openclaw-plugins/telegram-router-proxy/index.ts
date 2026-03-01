// OpenClaw Plugin: Telegram Router Proxy
// 让 OpenClaw 通过路由服务发送 Telegram 消息

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

const FETCH_PATCH_KEY = '__pinaiTelegramRouterFetchPatched__';
const PROXYABLE_TELEGRAM_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendVideo',
  'sendAnimation',
  'sendAudio',
  'sendVoice',
  'sendDocument',
  'sendMediaGroup',
  'sendChatAction',
  'editMessageText',
  'deleteMessage',
  'answerCallbackQuery'
]);

const plugin = {
  id: 'telegram-router-proxy',
  name: 'Telegram Router Proxy',
  description: 'Proxy Telegram API calls through router service',

  register(api: OpenClawPluginApi) {
    const routerUrl = process.env.TELEGRAM_ROUTER_URL || 'http://host.docker.internal:3001';

    api.logger.info(`Telegram Router Proxy enabled: ${routerUrl}`);
    api.logger.info('TRP_VERSION_20260228A');
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
      if (typeof input === 'string' || input instanceof URL) {
        const targetUrl = new URL(String(input));
        const methodName = extractTelegramMethod(targetUrl);
        if (methodName && PROXYABLE_TELEGRAM_METHODS.has(methodName)) {
          const proxyUrl = `${normalizedRouter}/api/telegram/${methodName}${targetUrl.search}`;
          const headers = new Headers(init?.headers || {});
          headers.delete('host');
          headers.delete('authorization');
          return await originalFetch(proxyUrl, {
            ...init,
            headers
          });
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
