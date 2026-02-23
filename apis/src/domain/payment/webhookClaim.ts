import Stripe from 'stripe';

const extractTelegramUserId = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const metadata = (payload as { metadata?: Record<string, unknown> }).metadata;
  const value = typeof metadata?.telegram_user_id === 'string' ? metadata.telegram_user_id.trim() : '';
  return value || undefined;
};

const extractAmount = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidates = [record.amount_total, record.amount_paid, record.amount_due, record.amount];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return Math.trunc(candidate);
  }
  return undefined;
};

const extractCurrency = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.currency === 'string' ? record.currency : undefined;
};

const extractStatus = (payload: unknown): string | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.status === 'string') return record.status;
  if (typeof record.payment_status === 'string') return record.payment_status;
  return undefined;
};

export interface StripeEventClaimPayload {
  stripe_event_id: string;
  event_type: string;
  raw_data: unknown;
  telegram_user_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
}

export const buildStripeEventClaimPayload = (event: Stripe.Event): StripeEventClaimPayload => {
  const eventObject = event.data.object;
  const claimPayload: StripeEventClaimPayload = {
    stripe_event_id: event.id.trim(),
    event_type: event.type.trim(),
    raw_data: eventObject
  };

  const telegramUserId = extractTelegramUserId(eventObject);
  const amount = extractAmount(eventObject);
  const currency = extractCurrency(eventObject);
  const status = extractStatus(eventObject);

  if (telegramUserId) claimPayload.telegram_user_id = telegramUserId;
  if (amount !== undefined) claimPayload.amount = amount;
  if (currency !== undefined) claimPayload.currency = currency;
  if (status !== undefined) claimPayload.status = status;

  return claimPayload;
};
