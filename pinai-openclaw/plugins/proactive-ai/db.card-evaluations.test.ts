/**
 * Tests for card_evaluations — pipeline self-review scores stored as
 * indexable rows (replaces the JSON blob inside pipeline_runs.iterations).
 * See docs/memory-architecture.md §三 (card_evaluations).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getCardEvaluation,
  listCardEvaluationsByRun,
  resetDbForTests,
  saveCardEvaluation,
  saveCardEvaluations,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-card-eval-'));
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

test('saveCardEvaluation: persists all dimension scores', async () => {
  await withTempHome(async () => {
    const row = await saveCardEvaluation({
      cardId: 'card-1',
      runId: 'run-1',
      intentKey: 'health/sleep',
      basket: 'health',
      dimensions: {
        relevance: 8.5,
        actionability: 7.0,
        whyNow: 8.0,
        novelty: 7.5,
        decisionCompression: 8.0,
      },
      overall: 7.8,
      pass: true,
      feedbackText: 'strong card',
    });

    assert.equal(row.card_id, 'card-1');
    assert.equal(row.run_id, 'run-1');
    assert.equal(row.basket, 'health');
    assert.equal(row.dim_relevance, 8.5);
    assert.equal(row.dim_actionability, 7.0);
    assert.equal(row.dim_why_now, 8.0);
    assert.equal(row.dim_novelty, 7.5);
    assert.equal(row.dim_decision_compress, 8.0);
    assert.equal(row.overall, 7.8);
    assert.equal(row.pass, true);
    assert.equal(row.evaluator, 'self');
    assert.equal(row.feedback_text, 'strong card');
  });
});

test('saveCardEvaluation: pass=false is stored as integer 0 and read back as boolean', async () => {
  await withTempHome(async () => {
    await saveCardEvaluation({
      cardId: 'card-2',
      runId: 'run-1',
      overall: 4.0,
      pass: false,
    });
    const row = await getCardEvaluation('card-2');
    assert.ok(row);
    assert.equal(row!.pass, false);
  });
});

test('saveCardEvaluation: re-saving same card_id updates existing row', async () => {
  await withTempHome(async () => {
    await saveCardEvaluation({ cardId: 'card-1', runId: 'run-1', overall: 6.0 });
    await saveCardEvaluation({ cardId: 'card-1', runId: 'run-2', overall: 8.0, basket: 'work' });
    const row = await getCardEvaluation('card-1');
    assert.ok(row);
    assert.equal(row!.run_id, 'run-2');
    assert.equal(row!.overall, 8.0);
    assert.equal(row!.basket, 'work');
  });
});

test('saveCardEvaluations: batch insert is transactional', async () => {
  await withTempHome(async () => {
    const out = await saveCardEvaluations([
      { cardId: 'a', runId: 'run-1', overall: 7.0, basket: 'work' },
      { cardId: 'b', runId: 'run-1', overall: 8.0, basket: 'work' },
      { cardId: 'c', runId: 'run-1', overall: 6.0, basket: 'health' },
    ]);
    assert.equal(out.length, 3);

    const rows = await listCardEvaluationsByRun('run-1');
    assert.equal(rows.length, 3);
    // Ordered by overall DESC
    assert.deepEqual(rows.map((r) => r.card_id), ['b', 'a', 'c']);
  });
});

test('saveCardEvaluations: empty batch is a no-op', async () => {
  await withTempHome(async () => {
    const out = await saveCardEvaluations([]);
    assert.equal(out.length, 0);
  });
});

test('listCardEvaluationsByRun: only returns rows for the requested run', async () => {
  await withTempHome(async () => {
    await saveCardEvaluations([
      { cardId: 'r1c1', runId: 'run-1', overall: 7.0 },
      { cardId: 'r1c2', runId: 'run-1', overall: 8.0 },
      { cardId: 'r2c1', runId: 'run-2', overall: 9.0 },
    ]);
    const r1 = await listCardEvaluationsByRun('run-1');
    const r2 = await listCardEvaluationsByRun('run-2');
    assert.equal(r1.length, 2);
    assert.equal(r2.length, 1);
    assert.equal(r2[0]!.card_id, 'r2c1');
  });
});

test('getCardEvaluation: missing card returns null', async () => {
  await withTempHome(async () => {
    assert.equal(await getCardEvaluation('does-not-exist'), null);
  });
});

test('saveCardEvaluation: missing dimensions stored as nulls (no defaults injected)', async () => {
  await withTempHome(async () => {
    const row = await saveCardEvaluation({ cardId: 'sparse', runId: 'run-1' });
    assert.equal(row.dim_relevance, null);
    assert.equal(row.dim_actionability, null);
    assert.equal(row.overall, null);
    assert.equal(row.pass, true); // Default pass=true
    assert.equal(row.evaluator, 'self');
  });
});
