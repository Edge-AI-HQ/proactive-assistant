/**
 * Supabase Auth middleware — server-side token verification via Supabase SDK.
 *
 * Uses supabase.auth.getUser(token) which validates the JWT against the
 * Supabase Auth service directly. Handles key rotation, algorithm changes,
 * and token revocation automatically.
 */

import { createClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';
import type { ProactiveAuthPayload } from './types.js';
import { upsertUser } from './user_service.js';

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
let devUserEnsured = false;
async function ensureDevUser(): Promise<void> {
  if (devUserEnsured) return;
  await upsertUser({
    userId: DEV_USER.userId,
    email: DEV_USER.email,
    name: DEV_USER.name,
    authProvider: 'dev',
  });
  devUserEnsured = true;
}

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

function applyDevAuth(req: Request, res: Response, next: NextFunction): void {
  ensureDevUser()
    .then(() => {
      req.proactiveAuth = { userId: DEV_USER.userId, email: DEV_USER.email };
      next();
    })
    .catch((err) => {
      console.error('[proactive-auth] dev user upsert failed:', err);
      res.status(500).json({ error: 'Dev auth bootstrap failed' });
    });
}

function applySupabaseAuth(token: string, req: Request, res: Response, next: NextFunction): void {
  supabase.auth.getUser(token).then(({ data, error }) => {
    if (error || !data.user) {
      console.error('[proactive-auth] getUser failed', { error: error?.message, status: error?.status, hasUser: !!data?.user });
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    const user = data.user;
    req.proactiveAuth = {
      userId: user.id,
      email: user.email ?? '',
      name: user.user_metadata?.full_name as string | undefined,
      avatarUrl: user.user_metadata?.avatar_url as string | undefined,
    };
    next();
  }).catch((err) => {
    console.error('[proactive-auth] Token verification error:', err);
    res.status(401).json({ error: 'Token verification failed' });
  });
}

/**
 * In dev: use a real Supabase JWT when present; otherwise synthesize a fixed user.
 * In prod: require a valid Supabase JWT in Authorization header.
 */
export function requireProactiveAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    if (!IS_PRODUCTION) {
      applyDevAuth(req, res, next);
      return;
    }
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }
  const token = authHeader.slice(7);
  applySupabaseAuth(token, req, res, next);
}
