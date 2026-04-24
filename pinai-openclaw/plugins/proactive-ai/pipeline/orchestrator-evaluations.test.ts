/**
 * Tests for extractCardEvaluationsForRun — the pure conversion from
 * agent-emitted score map → card_evaluations DB rows.
 *
 * Plus a small DB integration confirming that the rows produced here are
 * accepted by db.saveCardEvaluations.
 *
 * See docs/plans/memory-architecture.mdx §三 (card_evaluations).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listCardEvaluationsByRun,
  resetDbForTests,
  saveCardEvaluations,
} from '../db.ts';
import { extractCardEvaluationsForRun } from './extract-evaluations.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-extract-eval-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const FINAL_CARDS = [
  { id: 'card-1', goalBasket: 'work', intentKey: 'work/offer' },
  { id: 'card-2', goalBasket: 'health', intentKey: 'health/checkup' },
];

test('extract: maps agent dimensions including whyNowClarity alias', () => {
  const scoreMap = {
    'card-1': {
      cardId: 'card-1',
      overall: 8.4,
      pass: true,
      feedback: 'tight',
      dimensions: {
        relevance: 9,
        actionability: 8,
        whyNowClarity: 8.5,         // unified-generator uses whyNowClarity
        novelty: 8,
        decisionCompression: 8.5,
      },
    },
  };
  const rows = extractCardEvaluationsForRun('run-1', scoreMap, FINAL_CARDS);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.cardId, 'card-1');
  assert.equal(r.runId, 'run-1');
  assert.equal(r.basket, 'work');
  assert.equal(r.intentKey, 'work/offer');
  assert.equal(r.dimensions?.whyNow, 8.5);     // alias resolved
  assert.equal(r.dimensions?.relevance, 9);
  assert.equal(r.overall, 8.4);
  assert.equal(r.pass, true);
  assert.equal(r.feedbackText, 'tight');
});

test('extract: also accepts the canonical "whyNow" dimension key', () => {
  const rows = extractCardEvaluationsForRun(
    'run-1',
    { 'card-1': { cardId: 'card-1', dimensions: { whyNow: 7.0 } } },
    FINAL_CARDS,
  );
  assert.equal(rows[0]!.dimensions?.whyNow, 7.0);
});

test('extract: derives pass from overall when pass is omitted', () => {
  const rows = extractCardEvaluationsForRun(
    'run-1',
    {
      'card-1': { cardId: 'card-1', overall: 6.0 },           // pass=true (>=5)
      'card-2': { cardId: 'card-2', overall: 4.0 },           // pass=false (<5)
    },
    FINAL_CARDS,
  );
  const byId = new Map(rows.map((r) => [r.cardId, r]));
  assert.equal(byId.get('card-1')!.pass, true);
  assert.equal(byId.get('card-2')!.pass, false);
});

test('extract: missing overall + missing pass defaults to pass=true', () => {
  const rows = extractCardEvaluationsForRun(
    'run-1',
    { 'card-1': { cardId: 'card-1' } },
    FINAL_CARDS,
  );
  assert.equal(rows[0]!.pass, true);
  assert.equal(rows[0]!.overall, undefined);
});

test('extract: scores referencing non-final cards are dropped', () => {
  const rows = extractCardEvaluationsForRun(
    'run-1',
    {
      'card-1': { cardId: 'card-1', overall: 7.0 },
      'phantom': { cardId: 'phantom', overall: 9.0 },     // not in finalCards → drop
    },
    FINAL_CARDS,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cardId, 'card-1');
});

test('extract: malformed entries are skipped without throwing', () => {
  const rows = extractCardEvaluationsForRun(
    'run-1',
    {
      a: null,
      b: 'not an object',
      c: { cardId: '' },                  // empty cardId
      d: { cardId: 'card-1', overall: 8 }, // valid
    },
    FINAL_CARDS,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cardId, 'card-1');
});

test('extract: empty scoreMap returns empty array', () => {
  assert.deepEqual(extractCardEvaluationsForRun('run-1', {}, FINAL_CARDS), []);
});

test('extract: empty runId returns empty array (refuses unscoped writes)', () => {
  assert.deepEqual(
    extractCardEvaluationsForRun('', { 'card-1': { cardId: 'card-1' } }, FINAL_CARDS),
    [],
  );
});

test('extract → saveCardEvaluations: rows are accepted by the DB layer', async () => {
  await withTempHome(async () => {
    const rows = extractCardEvaluationsForRun(
      'run-XYZ',
      {
        'card-1': {
          cardId: 'card-1',
          overall: 8.4,
          pass: true,
          dimensions: { relevance: 9, whyNowClarity: 8.5 },
          feedback: 'good',
        },
        'card-2': { cardId: 'card-2', overall: 4.5, pass: false },
      },
      FINAL_CARDS,
    );
    await saveCardEvaluations(rows);
    const persisted = await listCardEvaluationsByRun('run-XYZ');
    assert.equal(persisted.length, 2);
    const byId = new Map(persisted.map((r) => [r.card_id, r]));
    assert.equal(byId.get('card-1')!.dim_why_now, 8.5);
    assert.equal(byId.get('card-1')!.basket, 'work');
    assert.equal(byId.get('card-2')!.pass, false);
  });
});
