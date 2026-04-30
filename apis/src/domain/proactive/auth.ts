/**
 * Supabase Auth middleware — server-side token verification + user upsert.
 *
 * Verifies the JWT against Supabase Auth, then upserts the local `users` row
 * so every downstream `/api/proactive/*` handler can rely on `req.proactiveAuth.user`
 * being present. This is the single point where Supabase identity becomes a
 * local user record.
 */

import crypto from 'node:crypto';
import { createClient, type User as SupabaseUser } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';
import type { ProactiveAuthPayload, ProactiveUser } from './types.js';
import { upsertUser as defaultUpsertUser } from './user_service.js';
import { setLogContextIdentity as defaultSetLogContextIdentity } from '../common/requestLogContext.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      proactiveAuth?: ProactiveAuthPayload;
    }
  }
}

const IS_PRODUCTION = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';

// Dev shortcut: when not in production and no Bearer token is provided,
// route the request through a single fixed local user. Mobile/local web
// sessions that do provide a Supabase token still resolve to the real user,
// so device registration and ingest test the same ownership path as prod.
//
// Production paths still require a real Supabase JWT — the prod env never
// sets NODE_ENV=development, so this branch can't trigger there.
const DEV_USER = {
  // Stable UUID v4 — `users.supabase_user_id` is UUID type, so we pin one.
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'dev@local.test',
  name: 'dev',
};
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? '';

if (IS_PRODUCTION && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.warn('[proactive-auth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_PUBLISHABLE_KEY — auth will fail');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Auth error codes shared across `/api/proactive/*` routes. Frontend uses
 * `code` (not the prose `error` field) to decide whether to silently refresh
 * the session, redirect to login, or surface a generic failure.
 */
export type ProactiveAuthErrorCode =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'UNAUTHORIZED';

export class TokenVerifyError extends Error {
  constructor(
    readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerifyError';
  }
}

export const isExpiredAuthError = (
  error: { message?: string; status?: number | undefined } | null | undefined,
): boolean => {
  if (!error) return false;
  if (error.status === 401) return true;
  return /expired|jwt expired|token.*expired/i.test(error.message ?? '');
};

/** Production verifier: hits the Supabase Auth service. */
const supabaseVerifyToken = async (token: string): Promise<SupabaseUser> => {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    const code = isExpiredAuthError(error) ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw new TokenVerifyError(code, error?.message ?? 'verification failed');
  }
  return data.user;
};

/**
 * Short-lived cache of successful Supabase token verifications.
 *
 * Each `/api/proactive/*` request verifies the JWT against Supabase Auth,
 * which is a 50–100ms HTTPS round-trip. A typical page load fires 5–10
 * requests in parallel — without caching, that's 500ms+ spent on the same
 * verification. 30s is short enough that token revocation latency stays
 * acceptable, while long enough to coalesce normal request bursts.
 *
 * Key = sha256(token). Value = verified Supabase user. Capped at 1024 entries
 * with FIFO eviction to bound memory; entries past TTL are treated as miss.
 */
export interface TokenCache {
  get(token: string): SupabaseUser | null;
  set(token: string, user: SupabaseUser): void;
  clear(): void;
  size(): number;
}

export function createTokenCache(opts: { ttlMs?: number; maxEntries?: number } = {}): TokenCache {
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxEntries = opts.maxEntries ?? 1024;
  const store = new Map<string, { user: SupabaseUser; expiresAt: number }>();

  const hashToken = (token: string): string =>
    crypto.createHash('sha256').update(token).digest('hex');

  return {
    get(token) {
      const key = hashToken(token);
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.user;
    },
    set(token, user) {
      const key = hashToken(token);
      if (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest) store.delete(oldest);
      }
      store.set(key, { user, expiresAt: Date.now() + ttlMs });
    },
    clear() { store.clear(); },
    size() { return store.size; },
  };
}

const sendAuthError = (
  res: Response,
  code: ProactiveAuthErrorCode,
  message: string,
): void => {
  res.status(401).json({ error: message, code });
};

async function applyDevFallback(
  req: Request,
  res: Response,
  next: NextFunction,
  deps: ProactiveAuthDeps,
): Promise<void> {
  try {
    const user = await deps.upsertUser({
      userId: DEV_USER.userId,
      email: DEV_USER.email,
      name: DEV_USER.name,
      authProvider: 'dev',
    });
    req.proactiveAuth = { userId: DEV_USER.userId, user };
    deps.setLogContextIdentity(DEV_USER.userId, user.display_name ?? user.email ?? DEV_USER.email);
    next();
  } catch (err) {
    console.error('[proactive-auth] dev user upsert failed:', err);
    res.status(500).json({ error: 'Dev auth bootstrap failed', code: 'DEV_AUTH_FAILED' });
  }
}

export interface ProactiveAuthDeps {
  /** Verifies a Bearer token and returns the Supabase user; throws TokenVerifyError on auth failure. */
  verifyToken: (token: string) => Promise<SupabaseUser>;
  /** Cache layer for verifyToken results. */
  cache: TokenCache;
  /** Upserts the local users row for the verified Supabase user. */
  upsertUser: typeof defaultUpsertUser;
  /** Adds the user identity to the per-request log context. */
  setLogContextIdentity: (
    userId: number | string | null | undefined,
    username?: string | null,
  ) => void;
  /** Allows local development requests with no Bearer token to use DEV_USER. */
  allowDevFallback?: boolean;
}

const defaultCache = createTokenCache();

const defaultDeps: ProactiveAuthDeps = {
  verifyToken: supabaseVerifyToken,
  cache: defaultCache,
  upsertUser: defaultUpsertUser,
  setLogContextIdentity: defaultSetLogContextIdentity,
  allowDevFallback: false,
};

/**
 * Build a `requireProactiveAuth` middleware. The factory exposes its
 * dependencies for tests; production code uses the default export.
 */
export function createRequireProactiveAuth(
  overrides: Partial<ProactiveAuthDeps> = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const deps: ProactiveAuthDeps = { ...defaultDeps, ...overrides };

  return async function requireProactiveAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      if (deps.allowDevFallback && !IS_PRODUCTION) {
        await applyDevFallback(req, res, next, deps);
        return;
      }
      sendAuthError(res, 'TOKEN_MISSING', 'Missing authorization token');
      return;
    }

    const token = authHeader.slice(7);

    let supabaseUser: SupabaseUser | null = deps.cache.get(token);
    if (!supabaseUser) {
      try {
        supabaseUser = await deps.verifyToken(token);
        deps.cache.set(token, supabaseUser);
      } catch (err) {
        if (err instanceof TokenVerifyError) {
          sendAuthError(res, err.code, 'Invalid or expired token');
          return;
        }
        console.error('[proactive-auth] Token verification error:', err);
        sendAuthError(res, 'UNAUTHORIZED', 'Token verification failed');
        return;
      }
    }

    let user: ProactiveUser;
    try {
      user = await deps.upsertUser({
        userId: supabaseUser.id,
        email: supabaseUser.email ?? '',
        name: supabaseUser.user_metadata?.full_name as string | undefined,
        avatarUrl: supabaseUser.user_metadata?.avatar_url as string | undefined,
      });
    } catch (err) {
      console.error('[proactive-auth] User upsert failed:', err);
      sendAuthError(res, 'UNAUTHORIZED', 'User provisioning failed');
      return;
    }

    req.proactiveAuth = { userId: supabaseUser.id, user };
    deps.setLogContextIdentity(supabaseUser.id, user.display_name ?? user.email ?? null);
    next();
  };
}

/**
 * In dev: use a real Supabase JWT when present; otherwise synthesize a fixed user.
 * In prod: require a valid Supabase JWT in Authorization header.
 */
export const requireProactiveAuth = createRequireProactiveAuth({
  allowDevFallback: !IS_PRODUCTION,
});
