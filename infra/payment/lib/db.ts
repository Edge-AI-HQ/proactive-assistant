import {
  createSupabasePool,
  requireSupabaseDbUrl
} from '@pin-ai/infra-supabase';
import {
  createPaymentStore,
  type PaymentSessionRecord,
  type PaymentStore,
  type UserSubscription
} from './paymentStore.js';

const dbUrl = requireSupabaseDbUrl(process.env.SUPABASE_DB_URL, 'Missing SUPABASE_DB_URL');
const pool = createSupabasePool(dbUrl, { max: 8, idleTimeoutMillis: 30_000 });

export const db: PaymentStore = createPaymentStore(pool);

export type { PaymentSessionRecord, PaymentStore, UserSubscription };
