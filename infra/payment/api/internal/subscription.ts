import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../../lib/db.js';
import { verifyInternalApiKey } from '../../lib/internalAuth.js';

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

  const telegramUserId = typeof req.query.telegram_user_id === 'string' ? req.query.telegram_user_id.trim() : '';
  if (!telegramUserId) {
    res.status(400).json({ error: 'telegram_user_id is required' });
    return;
  }

  try {
    const subscription = await db.getSubscriptionByTelegramId(telegramUserId);
    res.status(200).json({ subscription });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
}
