import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { config } from '../common/config.js';
import { getAssistantById, getGatewaySession, getUserByTelegramId } from '../common/db/index.js';
import { setLogContextTelegramIdentity } from '../common/requestLogContext.js';
import type { AssistantRecord, UserRecord } from '../../types.js';

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

export const readCookieFromIncoming = (req: IncomingMessage, name: string): string | undefined => {
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

export const gatewayBasePath = (telegramUserId: number): string => `/gateway/${telegramUserId}`;

const gatewayLoginPath = (telegramUserId: number, nextPath: string): string => {
  return `/auth/telegram/gateway?user_id=${telegramUserId}&next=${encodeURIComponent(nextPath)}`;
};

export const stripGatewaySidFromUrl = (urlValue: string): string => {
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

export const resolveGatewayUser = async (userIdParam: string): Promise<UserRecord | null> => {
  const userId = parsePositiveInt(userIdParam);
  if (userId === null) return null;
  const user = await getUserByTelegramId(userId);
  if (user) {
    setLogContextTelegramIdentity(user.telegram_user_id, user.telegram_username);
  }
  return user ?? null;
};

export const resolveGatewayAssistantForUser = async (
  ownerTelegramUserId: number,
  assistantIdParam: string
): Promise<AssistantRecord | null> => {
  const assistantId = parsePositiveInt(assistantIdParam);
  if (assistantId === null) return null;
  const assistant = await getAssistantById(assistantId);
  if (!assistant || assistant.owner_telegram_user_id !== ownerTelegramUserId) return null;
  return assistant;
};

export const requireGatewaySession = async (
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
      setLogContextTelegramIdentity(user.telegram_user_id, user.telegram_username);
      console.info('[auth:resolved]', {
        source: 'gateway_session_cookie',
        telegram_user_id: user.telegram_user_id,
        telegram_username: user.telegram_username ?? null
      });
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
      setLogContextTelegramIdentity(user.telegram_user_id, user.telegram_username);
      console.info('[auth:resolved]', {
        source: 'gateway_session_query',
        telegram_user_id: user.telegram_user_id,
        telegram_username: user.telegram_username ?? null
      });
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
