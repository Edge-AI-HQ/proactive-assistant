import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import type { Bot, Context } from 'grammy';
import { config } from '../config.js';
import { createGatewaySession, getUserByTelegramId } from '../db.js';

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

const parseTelegramUserId = (value: unknown): number | null => {
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

const renderSimplePage = (res: Response, title: string, message: string): void => {
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:ui-sans-serif,system-ui;max-width:680px;margin:40px auto;padding:16px;">
  <h2>${title}</h2><p>${message}</p></body></html>`);
};

const gatewayBasePath = (telegramUserId: number): string => `/gateway/${telegramUserId}`;

const sanitizeGatewayNextPath = (telegramUserId: number, value: unknown): string => {
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

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

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

  if (!checkString) return { ok: false };

  const secret = crypto.createHash('sha256').update(config.telegram.token).digest();
  const expectedHash = crypto.createHmac('sha256', secret).update(checkString).digest();
  const actualHash = Buffer.from(hash, 'hex');
  if (actualHash.length !== expectedHash.length) return { ok: false };
  if (!crypto.timingSafeEqual(actualHash, expectedHash)) return { ok: false };

  return { ok: true, telegramUserId };
};

const renderGatewayTelegramLoginPage = (res: Response, params: {
  telegramUserId: number;
  botUsername: string;
  callbackUrl: string;
}): void => {
  const { telegramUserId, botUsername, callbackUrl } = params;
  const escapedBotUsername = escapeHtml(botUsername);
  const escapedCallback = escapeHtml(callbackUrl);

  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegram Login Required</title>
  </head>
  <body style="font-family:ui-sans-serif,system-ui;max-width:680px;margin:40px auto;padding:16px;line-height:1.5;">
    <h2>Sign in with Telegram</h2>
    <p>Please sign in with Telegram account <strong>${telegramUserId}</strong> to continue.</p>
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${escapedBotUsername}"
      data-size="large"
      data-auth-url="${escapedCallback}"
      data-request-access="write"></script>
    <p style="margin-top:16px;color:#475569;">After login, you will be redirected to the Gateway dashboard automatically. For one-tap login inside Telegram app, use the /gateway command in your bot chat.</p>
  </body>
</html>`);
};

export const registerAuthRoutes = (app: Application, bot?: Bot<Context>): void => {
  app.get('/auth/telegram/gateway', (req: Request, res: Response) => {
    const requestedUserId = parseTelegramUserId(req.query.user_id);
    if (!requestedUserId) {
      renderSimplePage(res, '访问失败', '无效的用户标识。请返回 Telegram 重新获取入口。');
      return;
    }

    const user = getUserByTelegramId(requestedUserId);
    if (!user) {
      renderSimplePage(res, '访问失败', '用户不存在。请先在 Telegram 使用 /start 初始化账号。');
      return;
    }

    const botUsername = bot?.botInfo?.username || config.telegram.botUsername;
    if (!botUsername) {
      renderSimplePage(res, '访问失败', '缺少 Telegram Bot 用户名配置，请联系管理员。');
      return;
    }

    const nextPath = sanitizeGatewayNextPath(user.telegram_user_id, req.query.next);
    const publicOrigin = resolvePublicOrigin(req);
    const callbackUrl = new URL('/auth/telegram/callback', publicOrigin);
    callbackUrl.searchParams.set('user_id', String(user.telegram_user_id));
    callbackUrl.searchParams.set('next', nextPath);

    renderGatewayTelegramLoginPage(res, {
      telegramUserId: user.telegram_user_id,
      botUsername,
      callbackUrl: callbackUrl.toString()
    });
  });

  app.get('/auth/telegram/callback', (req: Request, res: Response) => {
    const requestedUserId = parseTelegramUserId(req.query.user_id);
    if (!requestedUserId) {
      renderSimplePage(res, '登录失败', '无效的用户标识。');
      return;
    }

    const user = getUserByTelegramId(requestedUserId);
    if (!user) {
      renderSimplePage(res, '登录失败', '用户不存在。请先在 Telegram 使用 /start 初始化账号。');
      return;
    }

    const verification = verifyTelegramLogin(req);
    if (!verification.ok) {
      renderSimplePage(res, '登录失败', 'Telegram 登录校验失败，请重试。');
      return;
    }

    if (verification.telegramUserId !== requestedUserId) {
      renderSimplePage(res, '登录失败', '当前 Telegram 账号与目标用户不匹配。');
      return;
    }

    const nextPath = sanitizeGatewayNextPath(user.telegram_user_id, req.query.next);
    const { sessionToken, expiresAt } = createGatewaySession(user.telegram_user_id, GATEWAY_SESSION_TTL_HOURS);
    setGatewaySessionCookie(res, user.telegram_user_id, sessionToken, expiresAt);
    res.redirect(nextPath);
  });
};
