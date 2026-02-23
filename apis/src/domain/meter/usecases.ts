import { getUserByLiteLLMUserId } from '../common/db/index.js';
import { DomainError } from '../common/errors.js';
import { db } from '../payment/db.js';
import { runDailyCreditsRefresh } from '../payment/maintenance.js';
import {
  reconcileWalletUsageFromLiteLLM,
  syncLiteLLMBudgetForUser,
  syncLiteLLMBudgetForWallet,
  walletAbsoluteBudgetUsd
} from '../payment/litellmBillingSync.js';

const parseTelegramUserId = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(raw)) return null;
  return raw;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolveBudgetUsdFromBody = (body: Record<string, unknown> | undefined): number | null => {
  if (!body) return null;

  const budgetUsd = parseNumber(body.budget_usd);
  if (budgetUsd !== null) {
    return Math.max(0, Number(budgetUsd.toFixed(6)));
  }

  const budgetCredits = parseNumber(body.budget_credits);
  if (budgetCredits !== null) {
    return Math.max(0, Number((budgetCredits / 100).toFixed(6)));
  }

  return null;
};

const walletCreditRemaining = (wallet: {
  daily_credits_remaining: number;
  monthly_credits_remaining: number;
}): number => {
  return Math.max(0, Math.trunc(wallet.daily_credits_remaining)) + Math.max(0, Math.trunc(wallet.monthly_credits_remaining));
};

const parseTelegramUserIdOrThrow = (value: unknown): string => {
  const telegramUserId = parseTelegramUserId(value);
  if (!telegramUserId) throw new DomainError('INVALID_INPUT', 'Invalid telegram_user_id');
  return telegramUserId;
};

export const readBudgetByTelegramUserId = async (telegramUserIdRaw: unknown) => {
  const telegramUserId = parseTelegramUserIdOrThrow(telegramUserIdRaw);

  const user = await db.getUserIdentityByTelegramId(telegramUserId);
  if (!user) throw new DomainError('NOT_FOUND', 'User identity not found');

  const wallet = await db.getWalletByUserId(user.id);
  return {
    telegram_user_id: telegramUserId,
    litellm_user_id: user.litellm_user_id,
    litellm_user_alias: user.litellm_user_alias,
    wallet,
    budget_usd: wallet ? walletAbsoluteBudgetUsd(wallet) : null,
    budget_credits: wallet ? walletAbsoluteBudgetUsd(wallet) * 100 : null
  };
};

export const updateBudgetByTelegramUserId = async (telegramUserIdRaw: unknown, body: Record<string, unknown> | undefined) => {
  const telegramUserId = parseTelegramUserIdOrThrow(telegramUserIdRaw);
  const budgetUsd = resolveBudgetUsdFromBody(body);
  if (budgetUsd === null) {
    throw new DomainError('INVALID_INPUT', 'budget_usd or budget_credits is required');
  }

  const user = await db.getUserIdentityByTelegramId(telegramUserId);
  if (!user) throw new DomainError('NOT_FOUND', 'User identity not found');

  const identity = await syncLiteLLMBudgetForUser({
    user_id: user.id,
    telegram_user_id: telegramUserId,
    telegram_username: user.telegram_username,
    litellm_user_id: user.litellm_user_id,
    litellm_user_alias: user.litellm_user_alias,
    budget_usd: budgetUsd
  });

  if (identity) {
    await db.upsertUserLiteLLMIdentity({
      telegram_user_id: telegramUserId,
      telegram_username: user.telegram_username,
      litellm_user_id: identity.litellm_user_id,
      litellm_user_alias: identity.litellm_user_alias,
      litellm_spend_usd: identity.litellm_spend_usd,
      litellm_budget_usd: identity.litellm_budget_usd,
      litellm_budget_duration: identity.litellm_budget_duration,
      litellm_last_synced_at: identity.litellm_last_synced_at
    });
  }

  return {
    ok: true,
    telegram_user_id: telegramUserId,
    budget_usd: budgetUsd,
    budget_credits: Number((budgetUsd * 100).toFixed(2)),
    litellm_identity: identity
  };
};

export const readCreditStatusByTelegramUserId = async (telegramUserIdRaw: unknown) => {
  const telegramUserId = parseTelegramUserIdOrThrow(telegramUserIdRaw);

  const identity = await db.getUserIdentityByTelegramId(telegramUserId);
  if (!identity) throw new DomainError('NOT_FOUND', 'User identity not found');

  const wallet = await db.getWalletByUserId(identity.id);
  const remainingCredits = wallet ? walletCreditRemaining(wallet) : 0;
  return {
    telegram_user_id: telegramUserId,
    remaining_credits: remainingCredits,
    remaining_usd: Number((remainingCredits / 100).toFixed(6)),
    allowed: remainingCredits > 0,
    reason: remainingCredits > 0 ? null : 'INSUFFICIENT_CREDITS'
  };
};

export const refreshDailyCredits = async (body: Record<string, unknown> | undefined) => {
  const limit = Math.min(1000, Math.max(1, Math.trunc(parseNumber(body?.limit) ?? 200)));
  const result = await runDailyCreditsRefresh({
    limit,
    source: 'meter_daily_refresh'
  });
  return {
    ok: true,
    scanned: result.scanned,
    applied: result.applied
  };
};

export const refreshMonthlyCredits = async (body: Record<string, unknown> | undefined) => {
  const telegramUserId = parseTelegramUserId(body?.telegram_user_id);
  const planId = typeof body?.plan_id === 'string' ? body.plan_id.trim() : '';
  const nextMonthlyRefreshAtRaw = typeof body?.next_monthly_refresh_at === 'string' ? body.next_monthly_refresh_at : '';

  if (!telegramUserId || !planId || !nextMonthlyRefreshAtRaw) {
    throw new DomainError('INVALID_INPUT', 'telegram_user_id, plan_id and next_monthly_refresh_at are required');
  }

  const nextMonthlyRefreshAt = new Date(nextMonthlyRefreshAtRaw);
  if (Number.isNaN(nextMonthlyRefreshAt.getTime())) {
    throw new DomainError('INVALID_INPUT', 'Invalid next_monthly_refresh_at');
  }

  const refresh = await db.applyMonthlyCreditsRefresh({
    telegram_user_id: telegramUserId,
    telegram_username: typeof body?.telegram_username === 'string' ? body.telegram_username.trim() || null : null,
    plan_id: planId,
    next_monthly_refresh_at: nextMonthlyRefreshAt,
    idempotency_key:
      typeof body?.idempotency_key === 'string' && body.idempotency_key.trim()
        ? body.idempotency_key.trim()
        : `monthly_refresh:${telegramUserId}:${nextMonthlyRefreshAt.toISOString()}`,
    source: 'meter_monthly_refresh',
    metadata: {
      trigger: 'api'
    }
  });

  if (refresh.wallet) {
    await syncLiteLLMBudgetForWallet(refresh.wallet);
  }

  return {
    ok: true,
    applied: refresh.applied,
    credits_increased: refresh.credits_increased,
    wallet: refresh.wallet
  };
};

export const handleLiteLLMBudgetAlert = async (body: Record<string, unknown> | undefined) => {
  const litellmUserId = typeof body?.user_id === 'string' ? body.user_id.trim() : '';
  if (!litellmUserId) {
    throw new DomainError('INVALID_INPUT', 'user_id (LiteLLM user_id) is required');
  }

  const user = await getUserByLiteLLMUserId(litellmUserId);
  if (!user) {
    throw new DomainError('NOT_FOUND', 'Mapped user not found for LiteLLM user_id');
  }

  const marker =
    typeof body?.event_id === 'string' && body.event_id.trim() ? body.event_id.trim() : new Date().toISOString();
  const wallet = await reconcileWalletUsageFromLiteLLM({
    user_id: user.id,
    telegram_user_id: String(user.telegram_user_id),
    source: 'litellm_budget_alert',
    marker
  });

  const remainingCredits = wallet ? walletCreditRemaining(wallet) : 0;
  const allow = remainingCredits > 0;

  return {
    ok: true,
    telegram_user_id: user.telegram_user_id,
    remaining_credits: remainingCredits,
    allow,
    error_code: allow ? null : 'INSUFFICIENT_CREDITS',
    message: allow ? 'Budget available' : 'Credit exhausted. Wait for next refresh.'
  };
};
