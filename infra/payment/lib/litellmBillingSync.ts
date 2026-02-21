import { db, type UserCreditWallet } from './db.js';
import { getLiteLLMUserSpendCents, syncLiteLLMBudgetForUser } from './litellmClient.js';

const normalizeCredits = (value: number | null | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;

export const walletAbsoluteBudgetUsd = (wallet: UserCreditWallet): number => {
  const totalCredits = normalizeCredits(wallet.daily_credits_remaining) + normalizeCredits(wallet.monthly_credits_remaining);
  const spentCredits = normalizeCredits(wallet.last_litellm_spend_cents);
  return Number(((totalCredits + spentCredits) / 100).toFixed(6));
};

export const syncLiteLLMBudgetForWallet = async (wallet: UserCreditWallet): Promise<void> => {
  const user = await db.getUserIdentityByTelegramId(wallet.telegram_user_id);
  if (!user) return;

  const identity = await syncLiteLLMBudgetForUser({
    user_id: user.id,
    telegram_user_id: wallet.telegram_user_id,
    telegram_username: user.telegram_username,
    litellm_user_id: user.litellm_user_id,
    litellm_user_alias: user.litellm_user_alias,
    budget_usd: walletAbsoluteBudgetUsd(wallet)
  });

  if (!identity) return;

  if (identity.litellm_user_id !== user.litellm_user_id || identity.litellm_user_alias !== user.litellm_user_alias) {
    await db.upsertUserLiteLLMIdentity({
      telegram_user_id: wallet.telegram_user_id,
      telegram_username: user.telegram_username,
      litellm_user_id: identity.litellm_user_id,
      litellm_user_alias: identity.litellm_user_alias
    });
  }
};

interface ReconcileUsageInput {
  user_id: number;
  telegram_user_id: string;
  source: string;
  marker: string;
  fallback_wallet?: UserCreditWallet | null;
}

export const reconcileWalletUsageFromLiteLLM = async (input: ReconcileUsageInput): Promise<UserCreditWallet | null> => {
  const user = await db.getUserIdentityByTelegramId(input.telegram_user_id);
  const litellmUserId = user?.litellm_user_id?.trim();
  if (!litellmUserId) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const currentSpendCents = await getLiteLLMUserSpendCents(litellmUserId);
  if (currentSpendCents === null) {
    return input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
  }

  const debit = await db.applyUsageDebitByUserId({
    user_id: input.user_id,
    litellm_spend_cents: currentSpendCents,
    idempotency_key: `usage_sync:${input.user_id}:${currentSpendCents}:${input.marker}`,
    source: input.source,
    metadata: {
      litellm_user_id: litellmUserId
    }
  });

  return debit.wallet ?? input.fallback_wallet ?? db.getWalletByUserId(input.user_id);
};
