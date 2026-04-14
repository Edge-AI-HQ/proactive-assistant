/**
 * Gateway UI session auth — ticket issuance + signed session cookie.
 *
 * Shared by the HTTP gateway proxy and the WebSocket upgrade handler.
 * All auth state is stateless (HMAC-signed tokens) — works across
 * multiple API server instances with no shared session store.
 *
 * Flow:
 *   1. Frontend requests a ticket (JWT-authed)
 *   2. Ticket is exchanged for a signed session cookie on first load
 *   3. Subsequent HTTP / WS requests validated via the cookie
 */

import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'node:http';

const SESSION_TTL_MS = 3_600_000; // 1 hour
const TICKET_TTL_MS = 60_000;     // 60 seconds
const COOKIE_NAME = 'gw_session';

// ── HMAC helpers ──

function getSecret(): string {
  const secret = process.env.API_INTERNAL_TOKEN;
  if (!secret) {
    throw new Error(
      'gateway_session: API_INTERNAL_TOKEN must be set. ' +
      'Cannot sign gateway tickets/sessions without a secret.',
    );
  }
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

function verifySignature(payload: string, sig: string): boolean {
  const expected = sign(payload);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Ticket (stateless, 60s TTL) ──

export function createTicket(userId: string): { ticket: string; expiresIn: number } {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  const payload = `${userId}:${expiresAt}`;
  const ticket = Buffer.from(`${payload}:${sign(payload)}`).toString('base64url');
  return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
}

/**
 * Validate a signed ticket and extract the userId.
 * Tickets are replayable within the TTL window — the redirect-and-strip-URL
 * pattern prevents casual reuse but does not guarantee single-use.
 */
export function validateTicket(ticket: string): string | null {
  try {
    const decoded = Buffer.from(ticket, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length < 3) return null;
    const sig = parts.pop()!;
    const expiresAt = parseInt(parts.pop()!, 10);
    const userId = parts.join(':'); // userId may contain colons
    if (isNaN(expiresAt) || expiresAt < Date.now()) return null;
    if (!verifySignature(`${userId}:${expiresAt}`, sig)) return null;
    return userId;
  } catch {
    return null;
  }
}

// ── Session cookie (stateless signed, 1h TTL) ──

export function setSessionCookie(res: Response, userId: string): void {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `session:${userId}:${expiresAt}`;
  const token = Buffer.from(`${userId}:${expiresAt}:${sign(payload)}`).toString('base64url');
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/api/gateway',
  });
}

/** Extract userId from signed session cookie (Express Request). */
export function getSessionUserId(req: Request): string | null {
  return extractUserIdFromCookie(req.headers.cookie);
}

/** Extract userId from signed session cookie (raw IncomingMessage for WS upgrade). */
export function getSessionUserIdRaw(req: IncomingMessage): string | null {
  return extractUserIdFromCookie(req.headers.cookie);
}

function extractUserIdFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const token = match[1]!;
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length < 3) return null;
    const sig = parts.pop()!;
    const expiresAt = parseInt(parts.pop()!, 10);
    const userId = parts.join(':');
    if (isNaN(expiresAt) || expiresAt < Date.now()) return null;
    if (!verifySignature(`session:${userId}:${expiresAt}`, sig)) return null;
    return userId;
  } catch {
    return null;
  }
}
