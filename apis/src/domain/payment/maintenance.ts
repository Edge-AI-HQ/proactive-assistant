import { db } from './db.js';
import { reconcileWalletUsageFromLiteLLM, syncLiteLLMBudgetForWallet } from './litellmBillingSync.js';

interface RunDailyCreditsRefreshInput {
  limit: number;
  source: string;
}

interface DailyCreditsRefreshResult {
  ok: true;
  scanned: number;
  applied: number;
  synced_to_litellm: number;
  errors: Array<{ user_id: number; message: string }>;
}

export const runDailyCreditsRefresh = async (input: RunDailyCreditsRefreshInput): Promise<DailyCreditsRefreshResult> => {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  const dueUsers = await db.listUsersDueDailyCreditRefresh(input.limit, now);

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
        source: input.source,
        marker: dayKey,
        fallback_wallet: currentWallet
      });

      const refresh = await db.refreshDailyCreditsByUserId({
        user_id: item.user_id,
        idempotency_key: `daily_refresh:${item.user_id}:${dayKey}`,
        source: input.source,
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

  return {
    ok: true,
    scanned: dueUsers.length,
    applied,
    synced_to_litellm: syncedToLiteLLM,
    errors
  };
};

export const runCreditsMaintenance = async (limit: number): Promise<DailyCreditsRefreshResult> => {
  return runDailyCreditsRefresh({
    limit,
    source: 'credits_maintenance'
  });
};
