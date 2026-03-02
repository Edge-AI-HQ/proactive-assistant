// OpenClaw Plugin: Telegram Router Proxy
// Proxy outbound Telegram API calls through the router service

const FETCH_PATCH_KEY = '__pinaiTelegramRouterFetchPatched__';
const NON_PROXYABLE_TELEGRAM_METHODS = new Set([
  'setWebhook',
  'deleteWebhook',
  'getWebhookInfo',
  'getMe',
  'logOut',
  'close'
]);

const plugin = {
  id: 'telegram-router-proxy',
  name: 'Telegram Router Proxy',
  description: 'Proxy Telegram API calls through router service',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {}
  },

  register(api) {
    const routerUrl = process.env.TELEGRAM_ROUTER_URL || 'http://host.docker.internal:3001';

    api.logger.info(`Telegram Router Proxy enabled: ${routerUrl}`);
    api.logger.info('TRP_VERSION_20260302A');
    installTelegramFetchProxy(api, routerUrl);
  }
};

function installTelegramFetchProxy(api, routerUrl) {
  if (globalThis[FETCH_PATCH_KEY]) {
    return;
  }
  if (typeof globalThis.fetch !== 'function') {
    api.logger.warn('Global fetch unavailable, skip Telegram fetch proxy patch');
    return;
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const normalizedRouter = routerUrl.replace(/\/+$/, '');

  globalThis.fetch = async (input, init) => {
    try {
      const rawUrl =
        typeof input === 'string' ? input
        : input instanceof URL ? input.toString()
        : input instanceof Request ? input.url
        : null;

      if (rawUrl) {
        const targetUrl = new URL(rawUrl);
        const methodName = extractTelegramMethod(targetUrl);
        if (methodName && !NON_PROXYABLE_TELEGRAM_METHODS.has(methodName)) {
          const proxyUrl = `${normalizedRouter}/api/telegram/${methodName}${targetUrl.search}`;
          const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}));
          headers.delete('host');
          headers.delete('authorization');

          const effectiveInit = {
            ...(input instanceof Request ? { method: input.method, body: input.body, redirect: input.redirect } : {}),
            ...init,
            headers
          };
          return await originalFetch(proxyUrl, effectiveInit);
        }
      }
    } catch (error) {
      api.logger.error(`Telegram fetch proxy rewrite failed: ${String(error)}`);
    }
    return await originalFetch(input, init);
  };

  globalThis[FETCH_PATCH_KEY] = true;
  api.logger.info('Telegram fetch proxy patch installed');
}

function extractTelegramMethod(url) {
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
