import crypto from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../../lib/db.js';
import { verifyInternalApiKey } from '../../lib/internalAuth.js';
import { readLandingBaseUrl } from '../../lib/urls.js';

const defaultTtlSeconds = 60 * 60;

const normalizeTtlSeconds = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return defaultTtlSeconds;
  return Math.min(24 * 60 * 60, Math.max(5 * 60, parsed));
};

const parseBody = (
  body: unknown
): { telegramUserId: string; telegramUsername: string | null; ttlSeconds: number } | null => {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;

  const telegramUserId = String(record.telegram_user_id ?? '').trim();
  if (!telegramUserId) return null;

  const telegramUsernameRaw = record.telegram_username;
  const telegramUsername =
    typeof telegramUsernameRaw === 'string' && telegramUsernameRaw.trim() ? telegramUsernameRaw.trim() : null;

  return {
    telegramUserId,
    telegramUsername,
    ttlSeconds: normalizeTtlSeconds(record.ttl_seconds)
  };
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = verifyInternalApiKey(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.reason });
    return;
  }

  const payload = parseBody(req.body);
  if (!payload) {
    res.status(400).json({ error: 'Invalid body. telegram_user_id is required.' });
    return;
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + payload.ttlSeconds * 1000).toISOString();

    await db.createPaymentSession({
      token,
      telegram_user_id: payload.telegramUserId,
      telegram_username: payload.telegramUsername ?? undefined,
      expires_at: expiresAt
    });

    const landingBaseUrl = readLandingBaseUrl(req);
    const subscribeUrl = `${landingBaseUrl}/api/subscribe?token=${encodeURIComponent(token)}`;

    res.status(200).json({
      token,
      expires_at: expiresAt,
      subscribe_url: subscribeUrl
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
}
