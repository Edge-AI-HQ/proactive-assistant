import type { Application, NextFunction, Request, Response } from 'express';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import httpProxy from 'http-proxy';
import { config } from '../config.js';
import { getUserByTelegramId } from '../db.js';

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

const openclawAuthHeaders: Record<string, string> = config.openclaw.apiKey
  ? { Authorization: `Bearer ${config.openclaw.apiKey}` }
  : {};

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

const authGateway = (
  req: Request<{ user_id: string }>,
  res: Response,
  next: NextFunction
): void => {
  const { user_id: userId } = req.params;

  const token =
    toSingleString(req.query.token) ||
    toSingleString(req.headers['x-gateway-token']) ||
    readCookie(req, 'gateway_token');

  const user = getUserByTelegramId(Number(userId));
  if (!user || token !== user.gateway_token) {
    res.status(403).send('Invalid gateway token.');
    return;
  }

  const currentCookieToken = readCookie(req, 'gateway_token');
  if (token && currentCookieToken !== token) {
    res.cookie('gateway_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: `/gateway/${user.telegram_user_id}`
    });
  }

  req.gatewayUser = user;
  next();
};

export const registerGatewayRoutes = (app: Application): void => {
  app.get('/gateway/:user_id', authGateway, (req: Request, res: Response) => {
    const user = req.gatewayUser;
    if (!user) {
      res.status(500).send('Gateway user missing.');
      return;
    }

    const token = user.gateway_token;
    res.redirect(`/gateway/${user.telegram_user_id}/proxy/overview?token=${token}`);
  });

  app.use('/gateway/:user_id/proxy', authGateway, (req: Request, res: Response) => {
    const user = req.gatewayUser;
    if (!user) {
      res.status(500).send('Gateway user missing.');
      return;
    }

    const prefix = `/gateway/${user.telegram_user_id}/proxy`;
    const url = new URL(req.originalUrl, 'http://localhost');
    url.pathname = url.pathname.replace(prefix, '') || '/';
    url.searchParams.delete('token');
    req.url = `${url.pathname}${url.search}`;

    proxy.web(req, res, {
      target: `http://127.0.0.1:${user.container_port}`,
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

export const registerGatewayWsProxy = (server: Server): void => {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/gateway\/(\d+)\/ws$/);
    if (!match) return;

    const userId = Number(match[1]);
    const token = url.searchParams.get('token');
    const user = getUserByTelegramId(userId);

    if (!user || token !== user.gateway_token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    req.url = `${config.openclaw.wsPath}`;
    proxy.ws(req, socket, head, {
      target: `ws://127.0.0.1:${user.container_port}`,
      changeOrigin: true,
      headers: openclawAuthHeaders
    });
  });
};
