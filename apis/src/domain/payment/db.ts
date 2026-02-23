import {
  createSupabasePool,
  requireSupabaseDbUrl
} from '../common/supabase/index.js';
import {
  createPaymentStore,
  type BillingPlan,
  type PaymentSessionRecord,
  type PaymentStore,
  type UserIdentity,
  type UserSubscription
} from './paymentStore.js';

const dbUrl = requireSupabaseDbUrl(process.env.SUPABASE_DB_URL, 'Missing SUPABASE_DB_URL');
const pool = createSupabasePool(dbUrl, { max: 8, idleTimeoutMillis: 30_000 });

export const db: PaymentStore = createPaymentStore(pool);

export type {
  BillingPlan,
  PaymentSessionRecord,
  PaymentStore,
  UserIdentity,
  UserSubscription
};
