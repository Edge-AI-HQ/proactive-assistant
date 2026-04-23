/**
 * End-to-end test for the online metrics — populates the v3 storage layer
 * with synthetic runs/cards/feedback, then asserts the snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  completeEvolutionRun,
  createEvolutionRun,
  logFeedback,
  resetDbForTests,
  saveCardEvaluations,
} from '../db.ts';
import { computeOnlineSnapshot } from './online.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-online-'));
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

test('computeOnlineSnapshot: aggregates per-basket metrics from card_evaluations + feedback_events', async () => {
  await withTempHome(async () => {
    const since = '2026-04-01T00:00:00Z';
    // Create a couple of runs so listEvolutionRuns has something to scan
    const r1 = await createEvolutionRun({ triggerKind: 'daily_dream', windowStart: since });
    await completeEvolutionRun(r1.id);
    const r2 = await createEvolutionRun({ triggerKind: 'manual', windowStart: since });
    await completeEvolutionRun(r2.id);

    // Save evaluations: 3 work cards (one strong, one weak), 2 health cards
    await saveCardEvaluations([
      { cardId: 'w1', runId: r1.id, basket: 'work',   overall: 8.0, pass: true },
      { cardId: 'w2', runId: r1.id, basket: 'work',   overall: 4.0, pass: false },
      { cardId: 'w3', runId: r2.id, basket: 'work',   overall: 7.5, pass: true },
      { cardId: 'h1', runId: r2.id, basket: 'health', overall: 6.0, pass: true },
      { cardId: 'h2', runId: r2.id, basket: 'health', overall: 5.5, pass: true },
    ]);

    // Feedback: confirm w1 + w3, dismiss w2
    await logFeedback({
      kind: 'card_feedback', action: 'confirm', source: 'user_direct', channel: 'web',
      intentCardId: 'w1',
    });
    await logFeedback({
      kind: 'card_feedback', action: 'confirm', source: 'user_direct', channel: 'web',
      intentCardId: 'w3',
    });
    await logFeedback({
      kind: 'card_feedback', action: 'dismiss', source: 'user_direct', channel: 'web',
      intentCardId: 'w2',
    });

    const snap = await computeOnlineSnapshot(since);
    assert.equal(snap.totalEvaluations, 5);
    const work = snap.byBasket.find((b) => b.basket === 'work');
    const health = snap.byBasket.find((b) => b.basket === 'health');
    assert.ok(work && health);
    assert.equal(work!.cardCount, 3);
    assert.equal(work!.confirmRate, 2 / 3);          // w1 + w3 confirmed
    assert.equal(work!.dismissRate, 1 / 3);          // w2 dismissed
    assert.equal(health!.cardCount, 2);
    assert.equal(health!.confirmRate, 0);
  });
});

test('computeOnlineSnapshot: empty DB returns zero stats (does not throw)', async () => {
  await withTempHome(async () => {
    const snap = await computeOnlineSnapshot('2026-04-01T00:00:00Z');
    assert.equal(snap.totalEvaluations, 0);
    assert.equal(snap.totalFeedback, 0);
    assert.equal(snap.byBasket.length, 0);
    assert.equal(snap.selfEvalConfirmCorrelation, 0);
  });
});
