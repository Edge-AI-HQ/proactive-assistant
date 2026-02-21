import {
  createSupabasePool,
  requireSupabaseDbUrl
} from '@pin-ai/infra-supabase';
import {
  createPaymentStore,
  type BillingPlan,
  type CreditMutationResult,
  type PaymentSessionRecord,
  type PaymentStore,
  type UserCreditWallet,
  type UserIdentity,
  type UserSubscription
} from './paymentStore.js';

const dbUrl = requireSupabaseDbUrl(process.env.SUPABASE_DB_URL, 'Missing SUPABASE_DB_URL');
const pool = createSupabasePool(dbUrl, { max: 8, idleTimeoutMillis: 30_000 });

export const db: PaymentStore = createPaymentStore(pool);

export type {
  BillingPlan,
  CreditMutationResult,
  PaymentSessionRecord,
  PaymentStore,
  UserCreditWallet,
  UserIdentity,
  UserSubscription
};
