import {
  type BillingPlan,
  type CurrentSubscriptionView,
  type PaymentSessionRecord,
  type Queryable,
  type StripeEventClaimResult,
  type SubscriptionInfoByStripe,
  type SubscriptionPeriod,
  type UserIdentity,
  type UserSubscription,
} from "./paymentStoreCore.js";
import { createPaymentSessionStore } from "./paymentStoreSession.js";
import { createPlanStore } from "./paymentStorePlan.js";
import { createSubscriptionPeriodStore } from "./paymentStorePeriods.js";
import { createIdentityStore } from "./paymentStoreIdentity.js";

export type {
  BillingPlan,
  CurrentSubscriptionView,
  PaymentSessionRecord,
  QueryExecutor,
  Queryable,
  StripeEventClaimResult,
  SubscriptionInfoByStripe,
  SubscriptionPeriod,
  UserIdentity,
  UserSubscription,
} from "./paymentStoreCore.js";

export interface PaymentStore {
  claimSubscriptionEventOrder(data: {
    stripe_subscription_id: string;
    event_created: number;
    event_id: string;
  }): Promise<StripeEventClaimResult>;
  claimStripeEvent(data: {
    telegram_user_id?: string;
    assistant_id?: number;
    stripe_event_id: string;
    event_type: string;
    amount?: number;
    currency?: string;
    status?: string;
    raw_data?: unknown;
  }): Promise<StripeEventClaimResult>;
  markStripeEventProcessed(stripe_event_id: string): Promise<void>;
  markStripeEventFailed(
    stripe_event_id: string,
    errorMessage: string,
  ): Promise<void>;
  ensureUserForTelegram(
    telegram_user_id: string,
    telegram_username?: string | null,
  ): Promise<{
    id: number;
    telegram_user_id: string;
    telegram_username: string | null;
  }>;
  upsertSubscriptionPeriod(data: {
    telegram_user_id: string;
    telegram_username?: string | null;
    stripe_subscription_id: string;
    stripe_customer_id?: string | null;
    stripe_invoice_id?: string | null;
    period_start: Date;
    period_end: Date;
    plan_id: string;
    status?: string;
    cancel_at_period_end?: boolean;
    assistant_id?: number | null;
  }): Promise<void>;
  getPeriodsToApplyBudget(now?: Date): Promise<SubscriptionPeriod[]>;
  markPeriodBudgetApplied(periodId: number): Promise<boolean>;
  getCurrentPeriodByTelegramId(
    telegram_user_id: string,
    now?: Date,
  ): Promise<CurrentSubscriptionView | null>;
  getSubscriptionInfoByStripeSubscriptionId(
    stripe_subscription_id: string,
  ): Promise<SubscriptionInfoByStripe | null>;
  getSubscriptionInfoByStripeCustomerId(
    stripe_customer_id: string,
  ): Promise<SubscriptionInfoByStripe | null>;
  getUsersWithEndedSubscriptionNoCurrentPeriod(
    now?: Date,
  ): Promise<
    Array<{ telegram_user_id: string; telegram_username: string | null }>
  >;
  updateSubscriptionCancelFlag(
    stripe_subscription_id: string,
    cancel_at_period_end: boolean,
    status?: string,
  ): Promise<boolean>;
  createPaymentSession(data: {
    token: string;
    telegram_user_id: string;
    telegram_username?: string;
    assistant_id?: number | null;
    plan_code?: string | null;
    expires_at: string;
  }): Promise<void>;
  getPaymentSessionByToken(token: string): Promise<PaymentSessionRecord | null>;
  markPaymentSessionUsed(token: string): Promise<void>;
  cleanupExpiredPaymentSessions(now?: Date): Promise<number>;
  listActivePlans(): Promise<BillingPlan[]>;
  getPlanByCode(planCode: string): Promise<BillingPlan | null>;
  getPlanByStripePriceId(stripePriceId: string): Promise<BillingPlan | null>;
  getUserIdentityByTelegramId(
    telegram_user_id: string,
  ): Promise<UserIdentity | null>;
  getLiteLLMKeyByTelegramId(telegram_user_id: string): Promise<string | null>;
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
}

export const createPaymentStore = (pool: Queryable): PaymentStore => {
  return {
    ...createSubscriptionPeriodStore(pool),
    ...createPaymentSessionStore(pool),
    ...createPlanStore(pool),
    ...createIdentityStore(pool),
  };
};
