import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { buildStripeEventClaimPayload } from './webhookClaim.js';

test('buildStripeEventClaimPayload extracts core fields', () => {
  const event = {
    id: 'evt_123',
    type: 'checkout.session.completed',
    created: 1_739_000_000,
    data: {
      object: {
        metadata: { telegram_user_id: '12345' },
        amount_total: 120,
        currency: 'usd',
        status: 'complete'
      }
    }
  } as unknown as Stripe.Event;

  const payload = buildStripeEventClaimPayload(event);
  assert.equal(payload.stripe_event_id, 'evt_123');
  assert.equal(payload.event_type, 'checkout.session.completed');
  assert.equal(payload.telegram_user_id, '12345');
  assert.equal(payload.amount, 120);
  assert.equal(payload.currency, 'usd');
  assert.equal(payload.status, 'complete');
});

test('buildStripeEventClaimPayload omits optional fields when unavailable', () => {
  const event = {
    id: 'evt_456',
    type: 'invoice.updated',
    created: 1_739_000_001,
    data: {
      object: {
        metadata: {}
      }
    }
  } as unknown as Stripe.Event;

  const payload = buildStripeEventClaimPayload(event);
  assert.equal(payload.stripe_event_id, 'evt_456');
  assert.equal(payload.event_type, 'invoice.updated');
  assert.equal(payload.telegram_user_id, undefined);
  assert.equal(payload.amount, undefined);
  assert.equal(payload.currency, undefined);
  assert.equal(payload.status, undefined);
});
