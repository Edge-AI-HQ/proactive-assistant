import {
  type BillingPlan,
  type PaymentSessionRecord,
  type Queryable,
  type StripeEventClaimResult,
  type UserIdentity,
  type UserSubscription,
} from "./paymentStoreCore.js";
import { createPaymentSessionStore } from "./paymentStoreSession.js";
import { createPlanStore } from "./paymentStorePlan.js";
import { createSubscriptionStore } from "./paymentStoreSubscription.js";
import { createIdentityStore } from "./paymentStoreIdentity.js";

export type {
  BillingPlan,
  PaymentSessionRecord,
  QueryExecutor,
  Queryable,
  StripeEventClaimResult,
  UserIdentity,
  UserSubscription,
} from "./paymentStoreCore.js";

export interface PaymentStore {
  upsertUserSubscription(data: {
    telegram_user_id: string;
    telegram_username?: string;
    stripe_customer_id: string;
    stripe_subscription_id?: string;
    plan_id?: string;
  }): Promise<UserSubscription>;
  getSubscriptionByTelegramId(
    telegram_user_id: string,
  ): Promise<UserSubscription | null>;
  getSubscriptionByStripeCustomerId(
    stripe_customer_id: string,
  ): Promise<UserSubscription | null>;
  getSubscriptionByStripeSubscriptionId(
    stripe_subscription_id: string,
  ): Promise<UserSubscription | null>;
  updateSubscriptionStatus(
    telegram_user_id: string,
    status:
      | "incomplete"
      | "incomplete_expired"
      | "trialing"
      | "active"
      | "past_due"
      | "canceled"
      | "unpaid"
      | "paused",
    period_start?: Date,
    period_end?: Date,
    cancel_at_period_end?: boolean,
    ended_at?: Date,
    stripe_status?: string,
    stripe_event_created?: number,
    stripe_event_id?: string,
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
  markStripeEventFailed(
    stripe_event_id: string,
    errorMessage: string,
  ): Promise<void>;
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
  getUserIdentityByTelegramId(
    telegram_user_id: string,
  ): Promise<UserIdentity | null>;
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
    ...createSubscriptionStore(pool),
    ...createPaymentSessionStore(pool),
    ...createPlanStore(pool),
    ...createIdentityStore(pool),
  };
};
