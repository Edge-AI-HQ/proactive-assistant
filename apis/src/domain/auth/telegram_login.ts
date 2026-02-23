import crypto from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import { config } from '../common/config.js';
import { createGatewaySession, getUserByTelegramId } from '../common/db/index.js';

const GATEWAY_SESSION_TTL_HOURS = 12;
const TELEGRAM_AUTH_MAX_AGE_SECONDS = 10 * 60;
const TELEGRAM_AUTH_FUTURE_SKEW_SECONDS = 60;
const EXCLUDED_TELEGRAM_SIGN_FIELDS = new Set(['hash', 'user_id', 'next']);

const toSingleString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
};

const toForwardedValue = (value: unknown): string | null => {
  const raw = toSingleString(value);
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  return first || null;
};

const isLocalHost = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.localhost')
  );
};

export const parseTelegramUserId = (value: unknown): number | null => {
  const raw = toSingleString(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseUnixSeconds = (value: unknown): number | null => {
  const raw = toSingleString(value);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const collectSignedFields = (req: Request): Array<[string, string]> => {
  const fields: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(req.query)) {
    if (EXCLUDED_TELEGRAM_SIGN_FIELDS.has(key)) continue;
    const value = toSingleString(raw);
    if (!value) continue;
    fields.push([key, value]);
  }
  return fields;
};

const verifyTelegramLogin = (req: Request): { ok: true; telegramUserId: number } | { ok: false } => {
  const telegramUserId = parseTelegramUserId(req.query.id);
  const authDate = parseUnixSeconds(req.query.auth_date);
  const hash = toSingleString(req.query.hash)?.toLowerCase();

  if (!telegramUserId || !authDate || !hash || !/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS || authDate - now > TELEGRAM_AUTH_FUTURE_SKEW_SECONDS) {
    return { ok: false };
  }

  const checkString = collectSignedFields(req)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  if (!checkString || !config.telegram.token) return { ok: false };

  const secret = crypto.createHash('sha256').update(config.telegram.token).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest();
  const actualHash = Buffer.from(hash, 'hex');
  if (actualHash.length !== expectedHash.length) return { ok: false };
  if (!crypto.timingSafeEqual(actualHash, expectedHash)) return { ok: false };

  return { ok: true, telegramUserId };
};

export const gatewayBasePath = (telegramUserId: number): string => `/gateway/${telegramUserId}`;

export const sanitizeGatewayNextPath = (telegramUserId: number, value: unknown): string => {
  const fallback = gatewayBasePath(telegramUserId);
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\r') || trimmed.includes('\n')) return fallback;
  const base = gatewayBasePath(telegramUserId);
  if (trimmed === base || trimmed.startsWith(`${base}/`)) {
    return trimmed;
  }
  return fallback;
};

const resolvePublicOrigin = (req: Request): string => {
  const forwardedProto = toForwardedValue(req.headers['x-forwarded-proto']);
  const forwardedHost = toForwardedValue(req.headers['x-forwarded-host']);
  const host = forwardedHost || req.get('host');
  const hostWithoutPort = host?.split(':')[0] || '';
  const proto =
    forwardedProto ||
    (req.secure ? 'https' : null) ||
    (!isLocalHost(hostWithoutPort) ? 'https' : 'http');

  if (host && (proto === 'https' || proto === 'http')) {
    return `${proto}://${host}`;
  }

  return new URL(config.publicBaseUrl).origin;
};

export const gatewaySessionCookieOptions = (telegramUserId: number, expiresAt: string): CookieOptions => {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: gatewayBasePath(telegramUserId),
    expires: new Date(expiresAt)
  };
};

export type StartGatewayTelegramAuthResult =
  | { kind: 'error'; title: string; message: string }
  | { kind: 'login'; telegramUserId: number; botUsername: string; callbackUrl: string };

export const startGatewayTelegramAuth = async (req: Request): Promise<StartGatewayTelegramAuthResult> => {
  const requestedUserId = parseTelegramUserId(req.query.user_id);
  if (!requestedUserId) {
    return { kind: 'error', title: '访问失败', message: '无效的用户标识。请返回 Telegram 重新获取入口。' };
  }

  const user = await getUserByTelegramId(requestedUserId);
  if (!user) {
    return {
      kind: 'error',
      title: '访问失败',
      message: '用户不存在。请先在 Telegram 使用 /start 初始化账号。'
    };
  }

  const botUsername = config.telegram.botUsername;
  if (!botUsername) {
    return {
      kind: 'error',
      title: '访问失败',
      message: '缺少 Telegram Bot 用户名配置，请联系管理员。'
    };
  }

  const nextPath = sanitizeGatewayNextPath(user.telegram_user_id, req.query.next);
  const publicOrigin = resolvePublicOrigin(req);
  const callbackUrl = new URL('/auth/telegram/callback', publicOrigin);
  callbackUrl.searchParams.set('user_id', String(user.telegram_user_id));
  callbackUrl.searchParams.set('next', nextPath);

  return {
    kind: 'login',
    telegramUserId: user.telegram_user_id,
    botUsername,
    callbackUrl: callbackUrl.toString()
  };
};

export type CompleteGatewayTelegramAuthResult =
  | { kind: 'error'; title: string; message: string }
  | { kind: 'redirect'; telegramUserId: number; nextPath: string; sessionToken: string; expiresAt: string };

export const completeGatewayTelegramAuth = async (req: Request): Promise<CompleteGatewayTelegramAuthResult> => {
  const requestedUserId = parseTelegramUserId(req.query.user_id);
  if (!requestedUserId) {
    return { kind: 'error', title: '登录失败', message: '无效的用户标识。' };
  }

  const user = await getUserByTelegramId(requestedUserId);
  if (!user) {
    return {
      kind: 'error',
      title: '登录失败',
      message: '用户不存在。请先在 Telegram 使用 /start 初始化账号。'
    };
  }

  const verification = verifyTelegramLogin(req);
  if (!verification.ok) {
    return { kind: 'error', title: '登录失败', message: 'Telegram 登录校验失败，请重试。' };
  }

  if (verification.telegramUserId !== requestedUserId) {
    return { kind: 'error', title: '登录失败', message: '当前 Telegram 账号与目标用户不匹配。' };
  }

  const nextPath = sanitizeGatewayNextPath(user.telegram_user_id, req.query.next);
  const { sessionToken, expiresAt } = await createGatewaySession(user.telegram_user_id, GATEWAY_SESSION_TTL_HOURS);

  return {
    kind: 'redirect',
    telegramUserId: user.telegram_user_id,
    nextPath,
    sessionToken,
    expiresAt
  };
};
