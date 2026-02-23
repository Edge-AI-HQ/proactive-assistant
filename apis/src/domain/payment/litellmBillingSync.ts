import { db, type UserCreditWallet } from './db.js';
import {
  createLiteLLMUser,
  getLiteLLMUserInfo,
  isLiteLLMClientEnabled,
  updateLiteLLMUser
} from '../litellm/client.js';

export interface LiteLLMIdentity {
  litellm_user_id: string;
  litellm_user_alias: string;
}

export interface LiteLLMBudgetSyncInput {
  user_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  litellm_user_id: string | null;
  litellm_user_alias: string | null;
  budget_usd: number;
}

export interface LiteLLMBudgetSyncResult extends LiteLLMIdentity {
  litellm_spend_usd: number | null;
  litellm_budget_usd: number | null;
  litellm_budget_duration: string | null;
  litellm_last_synced_at: string;
}

const normalizeCredits = (value: number | null | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;

const normalizeBudgetUsd = (value: number): number => {
  return Number.isFinite(value) ? Math.max(0, Number(value.toFixed(6))) : 0;
};

const buildDefaultLiteLLMUserId = (userId: number): string => String(Math.max(0, Math.trunc(userId)));

const buildDefaultLiteLLMAlias = (telegramUserId: string, telegramUsername: string | null): string => {
  const username = (telegramUsername || '').trim();
  return username ? `telegram:${telegramUserId}:@${username}` : `telegram:${telegramUserId}`;
};

const shouldRetryAfterCreate = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return lower.includes('not found') || lower.includes('does not exist') || lower.includes('unknown');
};

export const walletAbsoluteBudgetUsd = (wallet: UserCreditWallet): number => {
  const totalCredits = normalizeCredits(wallet.daily_credits_remaining) + normalizeCredits(wallet.monthly_credits_remaining);
  const spentCredits = normalizeCredits(wallet.last_litellm_spend_cents);
  return Number(((totalCredits + spentCredits) / 100).toFixed(6));
};

const persistLiteLLMUserSnapshot = async (
  telegramUserId: string,
  telegramUsername: string | null,
  snapshot: LiteLLMBudgetSyncResult
): Promise<void> => {
  await db.upsertUserLiteLLMIdentity({
    telegram_user_id: telegramUserId,
    telegram_username: telegramUsername,
    litellm_user_id: snapshot.litellm_user_id,
    litellm_user_alias: snapshot.litellm_user_alias,
    litellm_spend_usd: snapshot.litellm_spend_usd,
    litellm_budget_usd: snapshot.litellm_budget_usd,
    litellm_budget_duration: snapshot.litellm_budget_duration,
    litellm_last_synced_at: snapshot.litellm_last_synced_at
  });
};

export const syncLiteLLMBudgetForUser = async (input: LiteLLMBudgetSyncInput): Promise<LiteLLMBudgetSyncResult | null> => {
  if (!isLiteLLMClientEnabled()) return null;

  const identity: LiteLLMIdentity = {
    litellm_user_id: (input.litellm_user_id || '').trim() || buildDefaultLiteLLMUserId(input.user_id),
    litellm_user_alias:
      (input.litellm_user_alias || '').trim() || buildDefaultLiteLLMAlias(input.telegram_user_id, input.telegram_username)
  };

  const targetBudgetUsd = normalizeBudgetUsd(input.budget_usd);
  const now = new Date().toISOString();

  await createLiteLLMUser({
    userId: identity.litellm_user_id,
    userAlias: identity.litellm_user_alias,
    maxBudgetUsd: 0,
    metadata: {
      source: 'apis-payment',
      user_id: input.user_id,
      telegram_user_id: input.telegram_user_id,
      telegram_username: input.telegram_username || null
    }
  });

  try {
    await updateLiteLLMUser({
      userId: identity.litellm_user_id,
      userAlias: identity.litellm_user_alias,
      maxBudgetUsd: targetBudgetUsd
    });
  } catch (error: unknown) {
    if (!shouldRetryAfterCreate(error)) throw error;

    await createLiteLLMUser({
      userId: identity.litellm_user_id,
      userAlias: identity.litellm_user_alias,
      maxBudgetUsd: 0,
      metadata: {
        source: 'apis-payment',
        user_id: input.user_id,
        telegram_user_id: input.telegram_user_id,
        telegram_username: input.telegram_username || null
      }
    });

    await updateLiteLLMUser({
      userId: identity.litellm_user_id,
      userAlias: identity.litellm_user_alias,
      maxBudgetUsd: targetBudgetUsd
    });
  }

  let info: Awaited<ReturnType<typeof getLiteLLMUserInfo>> | null = null;
  try {
    info = await getLiteLLMUserInfo(identity.litellm_user_id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn('[litellm] failed to fetch user info after budget sync', {
      userId: identity.litellm_user_id,
      message
    });
  }

  return {
    litellm_user_id: identity.litellm_user_id,
    litellm_user_alias: identity.litellm_user_alias,
    litellm_spend_usd: info?.spendUsd ?? null,
    litellm_budget_usd: info?.maxBudgetUsd ?? targetBudgetUsd,
    litellm_budget_duration: info?.budgetDuration ?? null,
    litellm_last_synced_at: now
  };
};

export const syncLiteLLMBudgetForWallet = async (wallet: UserCreditWallet): Promise<void> => {
  const user = await db.getUserIdentityByTelegramId(wallet.telegram_user_id);
  if (!user) return;

  const snapshot = await syncLiteLLMBudgetForUser({
    user_id: user.id,
    telegram_user_id: wallet.telegram_user_id,
    telegram_username: user.telegram_username,
    litellm_user_id: user.litellm_user_id,
    litellm_user_alias: user.litellm_user_alias,
    budget_usd: walletAbsoluteBudgetUsd(wallet)
  });

  if (!snapshot) return;
  await persistLiteLLMUserSnapshot(wallet.telegram_user_id, user.telegram_username, snapshot);
};

interface ReconcileUsageInput {
  user_id: number;
  telegram_user_id: string;
  source: string;
  marker: string;
  fallback_wallet?: UserCreditWallet | null;
}

export const reconcileWalletUsageFromLiteLLM = async (input: ReconcileUsageInput): Promise<UserCreditWallet | null> => {
  if (!isLiteLLMClientEnabled()) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const user = await db.getUserIdentityByTelegramId(input.telegram_user_id);
  if (!user) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const litellmUserId = user.litellm_user_id?.trim();
  if (!litellmUserId) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const info = await getLiteLLMUserInfo(litellmUserId);
  if (info.spendUsd === null) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const currentSpendCents = Math.max(0, Math.trunc(info.spendUsd * 100));
  const syncedAt = new Date().toISOString();

  const debit = await db.applyUsageDebitByUserId({
    user_id: input.user_id,
    litellm_spend_cents: currentSpendCents,
    idempotency_key: `usage_sync:${input.user_id}:${currentSpendCents}:${input.marker}`,
    source: input.source,
    metadata: {
      litellm_user_id: litellmUserId,
      litellm_budget_usd: info.maxBudgetUsd
    }
  });

  await persistLiteLLMUserSnapshot(input.telegram_user_id, user.telegram_username, {
    litellm_user_id: litellmUserId,
    litellm_user_alias: user.litellm_user_alias || buildDefaultLiteLLMAlias(input.telegram_user_id, user.telegram_username),
    litellm_spend_usd: info.spendUsd,
    litellm_budget_usd: info.maxBudgetUsd,
    litellm_budget_duration: info.budgetDuration,
    litellm_last_synced_at: syncedAt
  });

  return debit.wallet ?? input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
};
