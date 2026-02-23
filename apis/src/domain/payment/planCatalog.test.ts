import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStripePriceIdForPlanCode,
  normalizePlanCode,
  resolvePlanCodeFromStripePriceId
} from './planCatalog.js';

test('normalizePlanCode accepts supported plans', () => {
  assert.equal(normalizePlanCode('basic'), 'basic');
  assert.equal(normalizePlanCode('Pro'), 'pro');
  assert.equal(normalizePlanCode(' MAX '), 'max');
});

test('normalizePlanCode rejects unsupported values', () => {
  assert.equal(normalizePlanCode('enterprise'), null);
  assert.equal(normalizePlanCode(''), null);
  assert.equal(normalizePlanCode(null), null);
});

test('price id mapping round-trips for configured ids', () => {
  for (const planCode of ['basic', 'pro', 'max'] as const) {
    const priceId = getStripePriceIdForPlanCode(planCode);
    if (!priceId) continue;
    assert.equal(resolvePlanCodeFromStripePriceId(priceId), planCode);
  }
});

test('reverse mapping rejects unknown price id', () => {
  assert.equal(resolvePlanCodeFromStripePriceId('price_unknown_123'), null);
  assert.equal(resolvePlanCodeFromStripePriceId(''), null);
});
