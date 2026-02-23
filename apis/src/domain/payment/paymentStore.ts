import {
  type BillingPlan,
  type CreditMutationResult,
  type PaymentSessionRecord,
  type Queryable,
  type StripeEventClaimResult,
  type UserCreditWallet,
  type UserIdentity,
  type UserSubscription
} from './paymentStoreCore.js';
import { createPaymentSessionStore } from './paymentStoreSession.js';
import { createPlanStore } from './paymentStorePlan.js';
import { createSubscriptionStore } from './paymentStoreSubscription.js';
import { createWalletStore } from './paymentStoreWallet.js';

export type {
  BillingPlan,
  CreditMutationResult,
  PaymentSessionRecord,
  QueryExecutor,
  Queryable,
  StripeEventClaimResult,
  UserCreditWallet,
  UserIdentity,
  UserSubscription
} from './paymentStoreCore.js';

export interface PaymentStore {
  upsertUserSubscription(data: {
    telegram_user_id: string;
    telegram_username?: string;
    stripe_customer_id: string;
    stripe_subscription_id?: string;
    plan_id?: string;
  }): Promise<UserSubscription>;
  getSubscriptionByTelegramId(telegram_user_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeCustomerId(stripe_customer_id: string): Promise<UserSubscription | null>;
  getSubscriptionByStripeSubscriptionId(stripe_subscription_id: string): Promise<UserSubscription | null>;
  updateSubscriptionStatus(
    telegram_user_id: string,
    status: 'active' | 'paused' | 'canceled' | 'pending',
    period_start?: Date,
    period_end?: Date,
    cancel_at_period_end?: boolean,
    stripe_event_created?: number,
    stripe_event_id?: string
  ): Promise<boolean>;
  claimStripeEvent(data: {
    telegram_user_id?: string;
    stripe_event_id: string;
    event_type: string;
    amount?: number;
    currency?: string;
    status?: string;
    raw_data?: unknown;
  }): Promise<StripeEventClaimResult>;
  markStripeEventProcessed(stripe_event_id: string): Promise<void>;
  markStripeEventFailed(stripe_event_id: string, errorMessage: string): Promise<void>;
  getActiveSubscriptions(): Promise<UserSubscription[]>;
  createPaymentSession(data: {
    token: string;
    telegram_user_id: string;
    telegram_username?: string;
    expires_at: string;
  }): Promise<void>;
  getPaymentSessionByToken(token: string): Promise<PaymentSessionRecord | null>;
  markPaymentSessionUsed(token: string): Promise<void>;
  cleanupExpiredPaymentSessions(now?: Date): Promise<number>;
  listActivePlans(): Promise<BillingPlan[]>;
  getPlanByCode(planCode: string): Promise<BillingPlan | null>;
  getPlanByStripePriceId(stripePriceId: string): Promise<BillingPlan | null>;
  getUserIdentityByTelegramId(telegram_user_id: string): Promise<UserIdentity | null>;
  upsertUserLiteLLMIdentity(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    litellm_user_id: string;
    litellm_user_alias?: string | null;
    litellm_spend_usd?: number | null;
    litellm_budget_usd?: number | null;
    litellm_budget_duration?: string | null;
    litellm_last_synced_at?: string | Date | null;
  }): Promise<UserIdentity>;
  getWalletByUserId(user_id: number): Promise<UserCreditWallet | null>;
  upsertWalletPlanContext(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    plan_id: string;
    next_monthly_refresh_at: Date;
  }): Promise<UserCreditWallet>;
  applyMonthlyCreditsRefresh(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    plan_id: string;
    next_monthly_refresh_at: Date;
    idempotency_key: string;
    source: string;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
  listUsersDueDailyCreditRefresh(limit: number, now?: Date): Promise<Array<{ user_id: number }>>;
  refreshDailyCreditsByUserId(data: {
    user_id: number;
    idempotency_key: string;
    source: string;
    now?: Date;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
  applyUsageDebitByUserId(data: {
    user_id: number;
    litellm_spend_cents: number;
    idempotency_key: string;
    source: string;
    metadata?: unknown;
  }): Promise<CreditMutationResult>;
}

export const createPaymentStore = (pool: Queryable): PaymentStore => {
  return {
    ...createSubscriptionStore(pool),
    ...createPaymentSessionStore(pool),
    ...createPlanStore(pool),
    ...createWalletStore(pool)
  };
};
