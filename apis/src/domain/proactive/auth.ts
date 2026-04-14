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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      proactiveAuth?: ProactiveAuthPayload;
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[proactive-auth] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / VITE_SUPABASE_PUBLISHABLE_KEY — auth will fail');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Express middleware: requires a valid Supabase JWT in Authorization header.
 */
export function requireProactiveAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }

  const token = authHeader.slice(7);

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
