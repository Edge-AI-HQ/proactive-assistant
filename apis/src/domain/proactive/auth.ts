/**
 * Supabase Auth middleware — local JWT verification (ADR-1).
 *
 * Supports both HS256 (legacy Supabase keys) and ES256 (new ECDSA keys).
 * For ES256, fetches the JWKS from Supabase once and caches the public key.
 */

import crypto from 'node:crypto';
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

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';

// ── JWKS cache for ES256 verification ──

interface JWK {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
}

let cachedJwks: JWK[] | null = null;
let jwksFetchedAt = 0;
const JWKS_CACHE_MS = 3600_000; // 1 hour

async function getJwks(): Promise<JWK[]> {
  if (cachedJwks && Date.now() - jwksFetchedAt < JWKS_CACHE_MS) {
    return cachedJwks;
  }

  const url = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const data = (await res.json()) as { keys: JWK[] };
    cachedJwks = data.keys;
    jwksFetchedAt = Date.now();
    return cachedJwks;
  } catch (err) {
    console.error('[proactive-auth] Failed to fetch JWKS:', err);
    return cachedJwks ?? [];
  }
}

function base64urlToBuffer(b64url: string): Buffer {
  return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jwkToPublicKey(jwk: JWK): crypto.KeyObject {
  // Build JWK object for Node's createPublicKey
  return crypto.createPublicKey({
    key: {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    },
    format: 'jwk',
  });
}

/**
 * Verify an ES256 JWT using the Supabase JWKS public key.
 */
async function verifyEs256Jwt(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  // Parse header to get kid
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (header.alg !== 'ES256') return null;

  // Find matching key
  const jwks = await getJwks();
  const jwk = header.kid
    ? jwks.find((k) => k.kid === header.kid)
    : jwks[0];

  if (!jwk) return null;

  // Verify signature
  const publicKey = jwkToPublicKey(jwk);
  const data = Buffer.from(`${headerB64}.${payloadB64}`);

  // ES256 signature in JWT is r||s (64 bytes), need to convert from base64url
  const sigBuf = base64urlToBuffer(signatureB64!);

  const isValid = crypto.verify(
    'sha256',
    data,
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    sigBuf,
  );

  if (!isValid) return null;

  // Decode payload
  try {
    const json = Buffer.from(payloadB64!, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;

    // Check expiration
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify an HS256 JWT using the shared JWT secret.
 */
function verifyHs256Jwt(token: string): Record<string, unknown> | null {
  if (!JWT_SECRET) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const data = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64url');

  // Normalize: base64 → base64url for comparison
  const actual = signatureB64!.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  if (expected !== actual) return null;

  // Decode payload
  try {
    const json = Buffer.from(payloadB64!, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;

    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a Supabase JWT — tries HS256 first, then ES256.
 */
async function verifySupabaseJwt(token: string): Promise<Record<string, unknown> | null> {
  // Peek at the algorithm
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) return null;

  try {
    const header = JSON.parse(Buffer.from(token.slice(0, dotIndex), 'base64url').toString('utf8'));
    if (header.alg === 'ES256') {
      return verifyEs256Jwt(token);
    }
  } catch {
    // Fall through to HS256
  }

  return verifyHs256Jwt(token);
}

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

  verifySupabaseJwt(token).then((payload) => {
    if (!payload || typeof payload.sub !== 'string') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const userMeta = payload.user_metadata as Record<string, unknown> | undefined;
    req.proactiveAuth = {
      userId: payload.sub,
      email: (payload.email as string) ?? '',
      name: userMeta?.full_name as string | undefined,
      avatarUrl: userMeta?.avatar_url as string | undefined,
    };

    next();
  }).catch((err) => {
    console.error('[proactive-auth] JWT verification error:', err);
    res.status(401).json({ error: 'Token verification failed' });
  });
}
