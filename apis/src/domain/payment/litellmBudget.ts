import {
  createLiteLLMUser,
  getLiteLLMUserInfo,
  isLiteLLMClientEnabled,
  resetLiteLLMUserSpend,
  updateLiteLLMKey,
  updateLiteLLMUser
} from '../litellm/client.js';
import { config } from '../common/config.js';
import { db } from './db.js';

type JsonRecord = Record<string, unknown>;

const buildDefaultLiteLLMUserId = (userId: number): string => String(Math.max(0, Math.trunc(userId)));

const buildDefaultLiteLLMAlias = (telegramUserId: string, telegramUsername: string | null): string => {
  const username = (telegramUsername || '').trim();
  return username ? `telegram:${telegramUserId}:@${username}` : `telegram:${telegramUserId}`;
};

const creditsToUsd = (credits: number): number => {
  if (!Number.isFinite(credits)) return 0;
  return Math.max(0, Number((credits / 100).toFixed(6)));
};

const planBudgetUsd = (monthlyRefreshCredits: number): number => {
  const monthly = Number.isFinite(monthlyRefreshCredits) ? Math.max(0, Math.trunc(monthlyRefreshCredits)) : 0;
  return creditsToUsd(monthly);
};

const normalizeBudgetUsd = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Number(value.toFixed(6)));
};

/**
 * 以 LiteLLM 表为准解析 budget，不再依赖 users.litellm_budget_usd。
 * 优先级：LiteLLM 已有值(>0) > 有效订阅的 plan > 配置默认值
 * 订阅 status 非 active/trialing/past_due 时返回 0，与支付流程的「过期清零」一致。
 */
export const resolveBudgetForUser = async (input: {
  litellm_user_id: string;
  telegram_user_id: string;
}): Promise<number | null> => {
  if (isLiteLLMClientEnabled()) {
    try {
      const info = await getLiteLLMUserInfo(input.litellm_user_id);
      if (info.maxBudgetUsd != null && Number.isFinite(info.maxBudgetUsd) && info.maxBudgetUsd > 0) {
        return info.maxBudgetUsd;
      }
    } catch {
      // LiteLLM 用户可能尚未创建，继续尝试 plan
    }
  }

  const sub = await db.getSubscriptionByTelegramId(input.telegram_user_id);
  const activeStatuses = ['active', 'trialing', 'past_due'] as const;
  if (sub) {
    if (!activeStatuses.includes(sub.status as (typeof activeStatuses)[number])) {
      return 0;
    }
    if (sub.plan_id) {
      const plan = await db.getPlanByCode(sub.plan_id);
      if (plan) {
        const budget = planBudgetUsd(plan.monthly_refresh_credits);
        if (budget > 0) return budget;
      }
    }
  }

  const fromConfig = config.litellm.defaultBudgetUsd;
  if (fromConfig != null && Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return null;
};

interface BudgetSyncInput {
  telegram_user_id: string;
  telegram_username?: string | null | undefined;
  source: string;
}

type LiteLLMResolvedIdentity = NonNullable<Awaited<ReturnType<typeof db.getUserIdentityByTelegramId>>>;

const resolveLiteLLMIdentity = async (
  input: BudgetSyncInput
): Promise<{ identity: LiteLLMResolvedIdentity; litellmUserId: string; litellmUserAlias: string } | null> => {
  const identity = await db.getUserIdentityByTelegramId(input.telegram_user_id);
  if (!identity) {
    console.warn('[payment] skip litellm budget sync: user identity not found', {
      telegramUserId: input.telegram_user_id,
      source: input.source
    });
    return null;
  }

  const litellmUserId = (identity.litellm_user_id || '').trim() || buildDefaultLiteLLMUserId(identity.id);
  const litellmUserAlias =
    (identity.litellm_user_alias || '').trim() ||
    buildDefaultLiteLLMAlias(input.telegram_user_id, input.telegram_username ?? identity.telegram_username);

  return {
    identity,
    litellmUserId,
    litellmUserAlias
  };
};

export const syncLiteLLMBudgetAbsolute = async (
  input: BudgetSyncInput & {
    budget_usd: number;
    metadata?: JsonRecord;
    reset_spend?: boolean;
  }
): Promise<void> => {
  if (!isLiteLLMClientEnabled()) return;

  const resolved = await resolveLiteLLMIdentity(input);
  if (!resolved) return;

  const { identity, litellmUserId, litellmUserAlias } = resolved;
  const targetBudgetUsd = normalizeBudgetUsd(input.budget_usd);

  await createLiteLLMUser({
    userId: litellmUserId,
    userAlias: litellmUserAlias,
    maxBudgetUsd: targetBudgetUsd,
    autoCreateKey: false,
    metadata: {
      source: input.source,
      telegram_user_id: input.telegram_user_id,
      user_id: identity.id,
      ...(input.metadata ?? {})
    }
  });

  if (input.reset_spend) {
    try {
      await resetLiteLLMUserSpend(litellmUserId);
      console.log(`[payment] Reset LiteLLM spend for user ${litellmUserId} (source: ${input.source})`);
    } catch (error: unknown) {
      console.error('[payment] Failed to reset LiteLLM spend, continuing with budget update', {
        userId: litellmUserId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await updateLiteLLMUser({
    userId: litellmUserId,
    userAlias: litellmUserAlias,
    maxBudgetUsd: targetBudgetUsd
  });

  const litellmKey = await db.getLiteLLMKeyByTelegramId(input.telegram_user_id);
  if (litellmKey) {
    try {
      await updateLiteLLMKey({ key: litellmKey, maxBudgetUsd: targetBudgetUsd });
    } catch (e) {
      console.warn('[payment] key budget sync failed (non-fatal)', {
        telegramUserId: input.telegram_user_id,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  await db.upsertUserLiteLLMIdentity({
    telegram_user_id: input.telegram_user_id,
    telegram_username: input.telegram_username ?? identity.telegram_username,
    litellm_user_id: litellmUserId,
    litellm_user_alias: litellmUserAlias,
    litellm_last_synced_at: new Date().toISOString()
  });
};

export const syncLiteLLMBudgetFromPlan = async (input: {
  telegram_user_id: string;
  telegram_username?: string | null;
  plan_code: string;
  source: string;
  reset_spend?: boolean;
}): Promise<void> => {
  if (!isLiteLLMClientEnabled()) return;

  const plan = await db.getPlanByCode(input.plan_code);
  if (!plan) {
    console.warn('[payment] skip litellm budget sync: plan not found', {
      telegramUserId: input.telegram_user_id,
      planCode: input.plan_code,
      source: input.source
    });
    return;
  }

  const targetBudgetUsd = planBudgetUsd(plan.monthly_refresh_credits);
  await syncLiteLLMBudgetAbsolute({
    telegram_user_id: input.telegram_user_id,
    telegram_username: input.telegram_username,
    source: input.source,
    budget_usd: targetBudgetUsd,
    ...(input.reset_spend != null ? { reset_spend: input.reset_spend } : {}),
    metadata: {
      plan_code: input.plan_code
    }
  });
};
