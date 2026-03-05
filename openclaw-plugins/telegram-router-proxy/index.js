// OpenClaw Plugin: Telegram Router Proxy
// Proxy outbound Telegram API calls through the router service

const FETCH_PATCH_KEY = '__pinaiTelegramRouterFetchPatched__';
const OPENCLAW_GATEWAY_PORT = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10);

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

const PASSTHROUGH_TELEGRAM_METHODS = new Set([
  'getWebhookInfo',
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
    const routerUrl = process.env.TELEGRAM_ROUTER_URL || 'http://host.docker.internal:3000';

    api.logger.info(`Telegram Router Proxy enabled: ${routerUrl}`);
    api.logger.info('TRP_VERSION_20260303B');
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
      const patchedGatewayInit = await patchCronAddDeliveryAccountId(input, init, api);
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

            const effectiveInit = {
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
    return await originalFetch(input, init);
  };

  globalThis[FETCH_PATCH_KEY] = true;
  api.logger.info('Telegram fetch proxy patch installed');
}

function extractTelegramApiPath(url) {
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

async function patchCronAddDeliveryAccountId(input, init, api) {
  const rawUrl =
    typeof input === 'string' ? input
    : input instanceof URL ? input.toString()
    : input instanceof Request ? input.url
    : '';
  if (!rawUrl) {
    return null;
  }
  let targetUrl;
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

  let bodyText = '';
  const rawBody = init?.body;
  if (typeof rawBody === 'string') {
    bodyText = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(rawBody);
  } else if (input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = '';
    }
  }
  if (!bodyText) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (parsed.method !== 'cron.add' || !isRecord(parsed.params)) {
    return null;
  }
  const job = parsed.params;
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const mode = typeof delivery.mode === 'string' ? delivery.mode.trim().toLowerCase() : '';
  if (mode === 'none' || mode === 'webhook') {
    return null;
  }
  const sessionKey =
    typeof job.sessionKey === 'string'
      ? job.sessionKey
      : isRecord(job.payload) && typeof job.payload.sessionKey === 'string'
        ? job.payload.sessionKey
        : '';
  const inferredAccountId = inferAccountIdFromSessionKey(sessionKey);
  const inferredPeerId = inferPeerIdFromSessionKey(sessionKey);
  if (!inferredAccountId && !inferredPeerId) {
    return null;
  }
  const existingTo = typeof delivery.to === 'string' ? delivery.to.trim() : '';
  const inferredTo = inferredPeerId ? `telegram:${inferredPeerId}` : '';
  const nextTo = inferredTo || existingTo;
  const nextMode = typeof delivery.mode === 'string' && delivery.mode.trim() ? delivery.mode : 'announce';
  const nextChannel =
    typeof delivery.channel === 'string' && delivery.channel.trim() ? delivery.channel : 'telegram';
  const existingAccountId =
    typeof delivery.accountId === 'string' && delivery.accountId.trim()
      ? delivery.accountId.trim().toLowerCase()
      : '';
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
    `[cron.add patch] sessionKey=${sessionKey || 'n/a'} accountId=${nextAccountId || 'n/a'} to=${nextTo || 'n/a'}`,
  );

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

function isOpenClawGatewayRpc(url) {
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

function inferAccountIdFromSessionKey(sessionKey) {
  const raw = (sessionKey || '').trim().toLowerCase();
  if (raw === 'agent:main:main') {
    return 'private';
  }
  if (/^telegram:\d+$/.test(raw)) {
    return 'private';
  }
  if (!raw.startsWith('agent:')) {
    return null;
  }
  const parts = raw.split(':').filter(Boolean);
  const rest = parts.slice(2);
  if (rest.length < 3) {
    return null;
  }
  const markerIndex = rest.findIndex(
    (part) => part === 'direct' || part === 'dm' || part === 'group' || part === 'channel',
  );
  if (markerIndex <= 0) {
    return null;
  }
  const segment = rest.slice(0, markerIndex);
  const candidate = segment[segment.length - 1]?.trim();
  if (!candidate) {
    return null;
  }
  if (candidate === 'public') {
    return 'default';
  }
  if (candidate === 'default' || candidate === 'private') {
    return candidate;
  }
  return null;
}

function inferPeerIdFromSessionKey(sessionKey) {
  const raw = (sessionKey || '').trim().toLowerCase();
  const tgMatch = raw.match(/^telegram:(\d+)$/);
  if (tgMatch?.[1]) {
    return tgMatch[1];
  }
  if (!raw.startsWith('agent:')) {
    return null;
  }
  const parts = raw.split(':').filter(Boolean);
  const markerIndex = parts.findIndex(
    (part) => part === 'direct' || part === 'dm' || part === 'group' || part === 'channel',
  );
  if (markerIndex < 0 || markerIndex + 1 >= parts.length) {
    return null;
  }
  const candidate = parts[markerIndex + 1]?.trim() || '';
  return /^\d+$/.test(candidate) ? candidate : null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default plugin;
