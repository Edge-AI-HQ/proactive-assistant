import type { Application, NextFunction, Request, Response } from 'express';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { config } from '../config.js';
import { getGatewaySession, getUserByTelegramId } from '../db.js';
import { ensureUserContainer, resolveGatewayTargetForUser } from '../docker/manager.js';
import type { UserRecord } from '../types.js';

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

const openclawAuthHeaders: Record<string, string> = config.openclaw.apiKey
  ? { Authorization: `Bearer ${config.openclaw.apiKey}` }
  : {};

const warmupInFlight = new Map<number, Promise<boolean>>();

const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
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
  return `/auth/google/gateway?user_id=${telegramUserId}&next=${encodeURIComponent(nextPath)}`;
};

const ensureGatewayContainerReady = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port'>
): Promise<boolean> => {
  const userId = user.telegram_user_id;
  const inFlight = warmupInFlight.get(userId);
  if (inFlight) return inFlight;

  const job = ensureUserContainer(user).then((result) => result.ready);
  void job.finally(() => {
    if (warmupInFlight.get(userId) === job) {
      warmupInFlight.delete(userId);
    }
  });

  warmupInFlight.set(userId, job);
  return job;
};

const ensureDashboardProxyContainerReady = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port' | 'container_status'>
): Promise<boolean> => {
  if (user.container_status === 'running') {
    return true;
  }
  return ensureGatewayContainerReady(user);
};

const resolveGatewayUser = (userIdParam: string): UserRecord | null => {
  if (!/^\d+$/.test(userIdParam)) return null;
  const user = getUserByTelegramId(Number.parseInt(userIdParam, 10));
  return user ?? null;
};

const requireGatewaySession = (
  req: Request<{ user_id: string }>,
  res: Response,
  next: NextFunction
): void => {
  const user = resolveGatewayUser(req.params.user_id);
  if (!user) {
    res.status(404).send('Gateway user not found.');
    return;
  }

  const sessionToken = readCookie(req, 'gateway_sid');
  if (!sessionToken) {
    res.redirect(gatewayLoginPath(user.telegram_user_id, req.originalUrl));
    return;
  }

  const session = getGatewaySession(sessionToken);
  if (!session || session.telegram_user_id !== user.telegram_user_id) {
    res.clearCookie('gateway_sid', { path: gatewayBasePath(user.telegram_user_id) });
    res.redirect(gatewayLoginPath(user.telegram_user_id, req.originalUrl));
    return;
  }

  req.gatewayUser = user;
  next();
};

const resolveGatewayWsUrl = (req: Request, telegramUserId: number): string => {
  const forwardedProto = toSingleString(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase();
  const protocol = forwardedProto === 'https' || req.secure ? 'wss' : 'ws';

  const forwardedHost = toSingleString(req.headers['x-forwarded-host'])?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  if (host) {
    return `${protocol}://${host}/gateway/${telegramUserId}/ws`;
  }

  const base = new URL(config.publicBaseUrl);
  const fallbackProtocol = base.protocol === 'https:' ? 'wss' : 'ws';
  return `${fallbackProtocol}://${base.host}/gateway/${telegramUserId}/ws`;
};

const renderGatewayBootstrapPage = (
  res: Response,
  params: { userId: number; gatewayUrl: string; gatewayToken: string }
): void => {
  const { userId, gatewayUrl, gatewayToken } = params;
  const nextPath = `/gateway/${userId}/proxy/overview`;
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
    <p>Preparing Gateway dashboard...</p>
    <script>${script}</script>
  </body>
</html>`);
};

export const registerDashboardProxyRoutes = (app: Application): void => {
  app.get('/gateway/:user_id', requireGatewaySession, async (req: Request, res: Response) => {
    const user = req.gatewayUser;
    if (!user) {
      res.status(500).send('Gateway user missing.');
      return;
    }

    try {
      const ready = await ensureGatewayContainerReady(user);
      if (!ready) {
        res.status(503).send('Gateway is starting. Please retry in a few seconds.');
        return;
      }
    } catch (error: unknown) {
      console.error('Gateway warmup failed', error);
      res.status(502).send('Gateway unavailable');
      return;
    }

    const gatewayUrl = resolveGatewayWsUrl(req, user.telegram_user_id);
    const gatewayToken = config.openclaw.apiKey || user.gateway_token;

    renderGatewayBootstrapPage(res, {
      userId: user.telegram_user_id,
      gatewayUrl,
      gatewayToken
    });
  });

  app.use('/gateway/:user_id/proxy', requireGatewaySession, async (req: Request, res: Response) => {
    const user = req.gatewayUser;
    if (!user) {
      res.status(500).send('Gateway user missing.');
      return;
    }

    try {
      const ready = await ensureDashboardProxyContainerReady(user);
      if (!ready) {
        res.status(503).send('Gateway is starting. Please retry in a few seconds.');
        return;
      }
    } catch (error: unknown) {
      console.error('Gateway warmup failed', error);
      res.status(502).send('Gateway unavailable');
      return;
    }

    const prefix = `/gateway/${user.telegram_user_id}/proxy`;
    const url = new URL(req.originalUrl, 'http://localhost');
    const pathAfterPrefix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    url.pathname = pathAfterPrefix || '/';
    url.searchParams.delete('token');
    req.url = `${url.pathname}${url.search}`;

    let target;
    try {
      target = resolveGatewayTargetForUser(user);
    } catch (error: unknown) {
      console.error('Gateway target resolve error', error);
      res.status(502).send('Gateway unavailable');
      return;
    }

    proxy.web(req, res, {
      target: target.httpBaseUrl,
      changeOrigin: true,
      headers: openclawAuthHeaders
    });
  });

  proxy.on('error', (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
    void req;
    console.error('Gateway proxy error', err);

    if ('writableEnded' in res && !res.writableEnded) {
      if ('statusCode' in res) {
        res.statusCode = 502;
      }
      res.end('Gateway unavailable');
    }
  });
};

export const registerDashboardWsProxy = (server: Server): void => {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/gateway\/(\d+)\/ws$/);
    if (!match) return;

    void (async () => {
      const userId = Number(match[1]);
      const user = getUserByTelegramId(userId);
      const sessionToken = readCookieFromIncoming(req, 'gateway_sid');

      if (!user || !sessionToken) {
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      const session = getGatewaySession(sessionToken);
      if (!session || session.telegram_user_id !== user.telegram_user_id) {
        rejectUpgrade(socket, '403 Forbidden');
        return;
      }

      try {
        const ready = await ensureDashboardProxyContainerReady(user);
        if (!ready) {
          rejectUpgrade(socket, '503 Service Unavailable');
          return;
        }
      } catch (error: unknown) {
        console.error('Gateway WS warmup failed', error);
        rejectUpgrade(socket, '502 Bad Gateway');
        return;
      }

      req.url = `${config.openclaw.wsPath}`;
      let target;
      try {
        target = resolveGatewayTargetForUser(user);
      } catch (error: unknown) {
        console.error('Gateway WS target resolve error', error);
        rejectUpgrade(socket, '502 Bad Gateway');
        return;
      }

      proxy.ws(req, socket, head, {
        target: target.wsBaseUrl,
        changeOrigin: false,
        headers: openclawAuthHeaders
      });
    })().catch((error: unknown) => {
      console.error('Gateway WS upgrade error', error);
      rejectUpgrade(socket, '500 Internal Server Error');
    });
  });
};
