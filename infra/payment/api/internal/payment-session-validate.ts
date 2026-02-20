import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../../lib/db.js';
import { verifyInternalApiKey } from '../../lib/internalAuth.js';

const toIso = (value: string): string => new Date(value).toISOString();

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = verifyInternalApiKey(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.reason });
    return;
  }

  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  try {
    const session = await db.getPaymentSessionByToken(token);
    if (!session) {
      res.status(404).json({ error: 'Invalid token' });
      return;
    }

    if (session.used) {
      res.status(400).json({ error: 'Token already used' });
      return;
    }

    if (new Date(session.expires_at) < new Date()) {
      res.status(400).json({ error: 'Token expired' });
      return;
    }

    res.status(200).json({
      token: session.token,
      telegram_user_id: session.telegram_user_id,
      telegram_username: session.telegram_username,
      used: false,
      expires_at: toIso(session.expires_at)
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
}
