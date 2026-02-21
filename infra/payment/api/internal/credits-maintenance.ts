import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../../lib/db.js';
import { verifyInternalApiKey } from '../../lib/internalAuth.js';
import { reconcileWalletUsageFromLiteLLM, syncLiteLLMBudgetForWallet } from '../../lib/litellmBillingSync.js';

const parseLimit = (value: unknown): number => {
  const raw = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(1000, Math.max(1, raw));
};

const isCronAuthorized = (req: VercelRequest): boolean => {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return false;

  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return false;

  const token = authHeader.slice(7).trim();
  return token === secret;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiAuth = verifyInternalApiKey(req);
  const cronAuth = isCronAuthorized(req);
  if (!apiAuth.ok && !cronAuth) {
    res.status(401).json({ error: apiAuth.reason });
    return;
  }

  const limit = parseLimit(req.method === 'GET' ? req.query.limit : (req.body as Record<string, unknown> | undefined)?.limit);
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  try {
    const dueUsers = await db.listUsersDueDailyCreditRefresh(limit, now);

    let applied = 0;
    let syncedToLiteLLM = 0;
    const errors: Array<{ user_id: number; message: string }> = [];

    for (const item of dueUsers) {
      try {
        const currentWallet = await db.getWalletByUserId(item.user_id);
        if (!currentWallet) continue;
        await reconcileWalletUsageFromLiteLLM({
          user_id: currentWallet.user_id,
          telegram_user_id: currentWallet.telegram_user_id,
          source: 'credits_maintenance',
          marker: dayKey,
          fallback_wallet: currentWallet
        });

        const refresh = await db.refreshDailyCreditsByUserId({
          user_id: item.user_id,
          idempotency_key: `daily_refresh:${item.user_id}:${dayKey}`,
          source: 'credits_maintenance',
          now,
          metadata: {
            triggered_at: now.toISOString()
          }
        });

        if (!refresh.applied || !refresh.wallet) continue;

        applied += 1;
        if (refresh.credits_increased > 0 || refresh.applied) {
          await syncLiteLLMBudgetForWallet(refresh.wallet);
          syncedToLiteLLM += 1;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ user_id: item.user_id, message });
      }
    }

    res.status(200).json({
      ok: true,
      scanned: dueUsers.length,
      applied,
      synced_to_litellm: syncedToLiteLLM,
      errors
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
}
