import Stripe from 'stripe';
import { DomainError } from '../common/errors.js';

const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
export const stripeWebhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();

export const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: '2023-10-16'
    })
  : null;

export const requireStripe = (): Stripe => {
  if (!stripe) {
    throw new DomainError('INTERNAL', 'STRIPE_SECRET_KEY is not configured', 500);
  }
  return stripe;
};

export const requireStripeWebhookSecret = (): string => {
  if (!stripeWebhookSecret) {
    throw new DomainError('INTERNAL', 'STRIPE_WEBHOOK_SECRET is not configured', 500);
  }
  return stripeWebhookSecret;
};

export const parseTelegramUserId = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!/^\d+$/.test(raw)) return null;
  return raw;
};

export const parseLimit = (value: unknown): number => {
  const raw = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(raw)) return 200;
  return Math.min(1000, Math.max(1, raw));
};
