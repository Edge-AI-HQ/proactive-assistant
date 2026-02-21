import type { Application, NextFunction, Request, Response } from 'express';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { config } from '../config.js';
import {
  getAssistantById,
  getGatewaySession,
  getUserByTelegramId
} from '../db.js';
import { ensureAssistantContainer, resolveGatewayTargetForUser } from '../modules/container/manager.js';
import { ensureLiteLLMKeyForAssistant } from '../modules/litellm/service.js';
import type { AssistantRecord, UserRecord } from '../types.js';

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
let proxyErrorHandlerBound = false;

const openclawAuthHeaders: Record<string, string> = config.openclaw.apiKey
  ? { Authorization: `Bearer ${config.openclaw.apiKey}` }
  : {};

const warmupInFlight = new Map<number, Promise<AssistantRecord | null>>();

const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const parsePositiveInt = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const readCookie = (req: Request, name: string): string | undefined => {
  const cookieJar = req.cookies as unknown;
  if (!cookieJar || typeof cookieJar !== 'object') return undefined;
  const raw = (cookieJar as Record<string, unknown>)[name];
  return typeof raw === 'string' ? raw : undefined;
};

const readCookieFromIncoming = (req: IncomingMessage, name: string): string | undefined => {
  const cookieHeader = toSingleString(req.headers.cookie);
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(';');
  for (const entry of cookies) {
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(entry.slice(idx + 1).trim());
  }

  return undefined;
};

const rejectUpgrade = (socket: Socket, statusLine: string): void => {
  socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  socket.destroy();
};

const gatewayBasePath = (telegramUserId: number): string => `/gateway/${telegramUserId}`;

const gatewayLoginPath = (telegramUserId: number, nextPath: string): string => {
  return `/auth/telegram/gateway?user_id=${telegramUserId}&next=${encodeURIComponent(nextPath)}`;
};

const stripGatewaySidFromUrl = (urlValue: string): string => {
  const parsed = new URL(urlValue, 'http://localhost');
  parsed.searchParams.delete('gateway_sid');
  return `${parsed.pathname}${parsed.search}`;
};

const setGatewaySessionCookie = (
  res: Response,
  telegramUserId: number,
  sessionToken: string,
  expiresAt: string
): void => {
  res.cookie('gateway_sid', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: gatewayBasePath(telegramUserId),
    expires: new Date(expiresAt)
  });
};

const ensureGatewayAssistantReady = async (assistant: AssistantRecord): Promise<AssistantRecord | null> => {
  const assistantId = assistant.id;
  const inFlight = warmupInFlight.get(assistantId);
  if (inFlight) return inFlight;

  const job = (async (): Promise<AssistantRecord | null> => {
    const assistantWithKey = await ensureLiteLLMKeyForAssistant(assistant.owner_telegram_user_id, assistant);
    const { containerId, ready } = await ensureAssistantContainer(assistantWithKey);
    if (!ready) return null;
    return {
      ...assistantWithKey,
      container_id: containerId,
      container_status: 'running'
    };
  })();

  void job.finally(() => {
    if (warmupInFlight.get(assistantId) === job) {
      warmupInFlight.delete(assistantId);
    }
  });

  warmupInFlight.set(assistantId, job);
  return job;
};

const resolveGatewayUser = async (userIdParam: string): Promise<UserRecord | null> => {
  const userId = parsePositiveInt(userIdParam);
  if (userId === null) return null;
  const user = await getUserByTelegramId(userId);
  return user ?? null;
};

const resolveGatewayAssistantForUser = async (
  ownerTelegramUserId: number,
  assistantIdParam: string
): Promise<AssistantRecord | null> => {
  const assistantId = parsePositiveInt(assistantIdParam);
  if (assistantId === null) return null;
  const assistant = await getAssistantById(assistantId);
  if (!assistant || assistant.owner_telegram_user_id !== ownerTelegramUserId) return null;
  return assistant;
};

const requireGatewaySession = async (
  req: Request<{ user_id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const user = await resolveGatewayUser(req.params.user_id);
  if (!user) {
    res.status(404).send('Gateway user not found.');
    return;
  }

  const cookieSessionToken = readCookie(req, 'gateway_sid');
  if (cookieSessionToken) {
    const session = await getGatewaySession(cookieSessionToken);
    if (session && session.telegram_user_id === user.telegram_user_id) {
      req.gatewayUser = user;
      next();
      return;
    }

    res.clearCookie('gateway_sid', { path: gatewayBasePath(user.telegram_user_id) });
  }

  const querySessionToken = toSingleString(req.query.gateway_sid);
  if (querySessionToken) {
    const querySession = await getGatewaySession(querySessionToken);
    if (querySession && querySession.telegram_user_id === user.telegram_user_id) {
      setGatewaySessionCookie(res, user.telegram_user_id, querySessionToken, querySession.expires_at);
      const cleanUrl = stripGatewaySidFromUrl(req.originalUrl);
      if (cleanUrl !== req.originalUrl) {
        res.redirect(cleanUrl);
        return;
      }
      req.gatewayUser = user;
      next();
      return;
    }
  }

  res.redirect(gatewayLoginPath(user.telegram_user_id, stripGatewaySidFromUrl(req.originalUrl)));
};

const resolveGatewayWsUrl = (req: Request, telegramUserId: number, assistantId: number): string => {
  const forwardedProto = toSingleString(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProto === 'https' || req.secure ? 'wss' : 'ws';

  const forwardedHost = toSingleString(req.headers['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  if (host) {
    return `${protocol}://${host}/gateway/${telegramUserId}/bot/${assistantId}/ws`;
  }

  const base = new URL(config.publicBaseUrl);
  const fallbackProtocol = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${fallbackProtocol}://${base.host}/gateway/${telegramUserId}/bot/${assistantId}/ws`;
};

const renderGatewayBootstrapPage = (
  res: Response,
  params: { userId: number; assistantId: number; gatewayUrl: string; gatewayToken: string }
): void => {
  const { userId, assistantId, gatewayUrl, gatewayToken } = params;
  const nextPath = `/gateway/${userId}/bot/${assistantId}/proxy/overview`;
  const script = `
(() => {
  const key = 'openclaw.control.settings.v1';
  const next = ${JSON.stringify(nextPath)};
  const gatewayUrl = ${JSON.stringify(gatewayUrl)};
  const token = ${JSON.stringify(gatewayToken)};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const merged = parsed && typeof parsed === 'object' ? parsed : {};
    merged.gatewayUrl = gatewayUrl;
    merged.token = token;
    localStorage.setItem(key, JSON.stringify(merged));
  } catch (error) {
    console.error('Gateway bootstrap failed', error);
  }
  window.location.replace(next);
})();
  `.trim();

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gateway Bootstrap</title>
  </head>
  <body>
    <p>Preparing assistant dashboard...</p>
    <script>${script}</script>
  </body>
</html>`);
};

export const registerGatewayRoutes = (app: Application): void => {
  const requireGatewaySessionMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    void requireGatewaySession(req as Request<{ user_id: string }>, res, next).catch((error: unknown) => {
      console.error('Gateway session check failed', error);
      res.status(500).send('Gateway session check failed.');
    });
  };

  app.get(
    '/gateway/:user_id/bot/:assistant_id',
    requireGatewaySessionMiddleware,
    async (req: Request<{ user_id: string; assistant_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send('Gateway user missing.');
        return;
      }

      const assistant = await resolveGatewayAssistantForUser(user.telegram_user_id, req.params.assistant_id);
      if (!assistant) {
        res.status(404).send('Assistant not found.');
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        if (assistant.container_status !== 'running') {
          readyAssistant = await ensureGatewayAssistantReady(assistant);
        }
        if (!readyAssistant) {
          res.status(503).send('Assistant container is starting. Please retry in a few seconds.');
          return;
        }
      } catch (error: unknown) {
        console.error('Assistant gateway warmup failed', error);
        res.status(502).send('Assistant gateway unavailable');
        return;
      }

      const gatewayUrl = resolveGatewayWsUrl(req, user.telegram_user_id, readyAssistant.id);
      const gatewayToken = config.openclaw.apiKey || user.gateway_token;

      renderGatewayBootstrapPage(res, {
        userId: user.telegram_user_id,
        assistantId: readyAssistant.id,
        gatewayUrl,
        gatewayToken
      });
    }
  );

  app.use(
    '/gateway/:user_id/bot/:assistant_id/proxy',
    requireGatewaySessionMiddleware,
    async (req: Request<{ user_id: string; assistant_id: string }>, res: Response) => {
      const user = req.gatewayUser;
      if (!user) {
        res.status(500).send('Gateway user missing.');
        return;
      }

      const assistant = await resolveGatewayAssistantForUser(user.telegram_user_id, req.params.assistant_id);
      if (!assistant) {
        res.status(404).send('Assistant not found.');
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        if (assistant.container_status !== 'running') {
          readyAssistant = await ensureGatewayAssistantReady(assistant);
        }
        if (!readyAssistant) {
          res.status(503).send('Assistant container is starting. Please retry in a few seconds.');
          return;
        }
      } catch (error: unknown) {
        console.error('Assistant gateway warmup failed', error);
        res.status(502).send('Assistant gateway unavailable');
        return;
      }

      const prefix = `/gateway/${user.telegram_user_id}/bot/${readyAssistant.id}/proxy`;
      const url = new URL(req.originalUrl, 'http://localhost');
      const pathAfterPrefix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
      url.pathname = pathAfterPrefix || '/';
      url.searchParams.delete('token');
      req.url = `${url.pathname}${url.search}`;

      let target: ReturnType<typeof resolveGatewayTargetForUser>;
      try {
        target = resolveGatewayTargetForUser({
          telegram_user_id: readyAssistant.owner_telegram_user_id,
          container_id: readyAssistant.container_id,
          container_port: readyAssistant.container_port
        });
      } catch (error: unknown) {
        console.error('Assistant gateway target resolve error', error);
        res.status(502).send('Assistant gateway unavailable');
        return;
      }

      proxy.web(req, res, {
        target: target.httpBaseUrl,
        changeOrigin: true,
        headers: openclawAuthHeaders
      });
    }
  );

  if (!proxyErrorHandlerBound) {
    proxy.on('error', (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
      void req;
      console.error('Gateway proxy error', err);

      if ('writableEnded' in res && !res.writableEnded) {
        if ('statusCode' in res) {
          res.statusCode = 502;
        }
        res.end('Assistant gateway unavailable');
      }
    });
    proxyErrorHandlerBound = true;
  }
};

export const registerGatewayWsProxy = (server: Server): void => {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/gateway\/(\d+)\/bot\/(\d+)\/ws$/);
    if (!match) return;

    void (async () => {
      const userIdRaw = match[1];
      const assistantIdRaw = match[2];
      if (!userIdRaw || !assistantIdRaw) {
        rejectUpgrade(socket, '400 Bad Request');
        return;
      }

      const userId = Number.parseInt(userIdRaw, 10);
      const assistantId = Number.parseInt(assistantIdRaw, 10);
      const user = await getUserByTelegramId(userId);
      const assistant = await getAssistantById(assistantId);
      const sessionToken = readCookieFromIncoming(req, 'gateway_sid');

      if (!user || !assistant || assistant.owner_telegram_user_id !== user.telegram_user_id || !sessionToken) {
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      const session = await getGatewaySession(sessionToken);
      if (!session || session.telegram_user_id !== user.telegram_user_id) {
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      let readyAssistant: AssistantRecord | null = assistant;
      try {
        if (assistant.container_status !== 'running') {
          readyAssistant = await ensureGatewayAssistantReady(assistant);
        }
        if (!readyAssistant) {
          rejectUpgrade(socket, '503 Service Unavailable');
          return;
        }
      } catch (error: unknown) {
        console.error('Assistant gateway WS warmup failed', error);
        rejectUpgrade(socket, '502 Bad Gateway');
        return;
      }

      req.url = '/';
      let target: ReturnType<typeof resolveGatewayTargetForUser>;
      try {
        target = resolveGatewayTargetForUser({
          telegram_user_id: readyAssistant.owner_telegram_user_id,
          container_id: readyAssistant.container_id,
          container_port: readyAssistant.container_port
        });
      } catch (error: unknown) {
        console.error('Assistant gateway WS target resolve error', error);
        rejectUpgrade(socket, '502 Bad Gateway');
        return;
      }

      proxy.ws(req, socket, head, {
        target: target.wsBaseUrl,
        changeOrigin: false,
        headers: openclawAuthHeaders
      });
    })().catch((error: unknown) => {
      console.error('Assistant gateway WS upgrade error', error);
      rejectUpgrade(socket, '500 Internal Server Error');
    });
  });
};
