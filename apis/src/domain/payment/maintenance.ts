import { db } from './db.js';
import { syncLiteLLMBudgetFromPlan } from './litellmBudget.js';

interface RunPlanBudgetMaintenanceInput {
  limit: number;
  source: string;
}

interface PlanBudgetMaintenanceResult {
  ok: true;
  scanned: number;
  applied: number;
  synced_to_litellm: number;
  synced: number;
  skipped: number;
  errors: Array<{ telegram_user_id: string; message: string }>;
}

export const runPlanBudgetMaintenance = async (
  input: RunPlanBudgetMaintenanceInput
): Promise<PlanBudgetMaintenanceResult> => {
  const activeSubscriptions = await db.getActiveSubscriptions();
  const candidates = activeSubscriptions.slice(0, Math.max(1, Math.trunc(input.limit)));

  let synced = 0;
  let skipped = 0;
  const errors: Array<{ telegram_user_id: string; message: string }> = [];

  for (const subscription of candidates) {
    const planCode = (subscription.plan_id || '').trim();
    if (!planCode) {
      skipped += 1;
      continue;
    }

    try {
      await syncLiteLLMBudgetFromPlan({
        telegram_user_id: subscription.telegram_user_id,
        telegram_username: subscription.telegram_username,
        plan_code: planCode,
        source: input.source
      });
      synced += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push({ telegram_user_id: subscription.telegram_user_id, message });
    }
  }

  return {
    ok: true,
    scanned: candidates.length,
    applied: synced,
    synced_to_litellm: synced,
    synced,
    skipped,
    errors
  };
};

export const runCreditsMaintenance = async (limit: number): Promise<PlanBudgetMaintenanceResult> => {
  return runPlanBudgetMaintenance({
    limit,
    source: 'credits_maintenance'
  });
};
