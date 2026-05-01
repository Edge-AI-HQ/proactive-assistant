/**
 * Tests for listVisibleCards — the cross-run flat card list backing
 * `GET /cards`. The contract is "newest run first, card order preserved
 * within a run, status='completed' only, no dedup."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listVisibleCards,
  markPipelineRunCompleted,
  markPipelineRunFailed,
  resetDbForTests,
  saveCardEvaluations,
  savePipelineRunStart,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-list-cards-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function seedCompletedRun(runId: string, cards: Array<Record<string, unknown>>) {
  await savePipelineRunStart({
    runId,
    trigger: 'manual',
    subagentRunId: `${runId}-sub`,
    subagentSessionKey: `${runId}-key`,
  });
  await markPipelineRunCompleted({
    runId,
    finalCards: cards,
    details: { plan: { reasoning: '' }, evaluation: { batchFeedback: '' } },
  });
}

test('listVisibleCards: returns cards across multiple completed runs, newest run first', async () => {
  await withTempHome(async () => {
    await seedCompletedRun('run-old', [
      { id: 'run-old_1', goalBasket: 'work', title: 'Old card 1' },
      { id: 'run-old_2', goalBasket: 'health', title: 'Old card 2' },
    ]);
    // Stagger so completed_at differs deterministically.
    await new Promise((r) => setTimeout(r, 5));
    await seedCompletedRun('run-new', [
      { id: 'run-new_1', goalBasket: 'work', title: 'New card 1' },
    ]);

    const rows = await listVisibleCards();
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.runId, 'run-new');
    assert.equal((rows[0]!.card as { title: string }).title, 'New card 1');
    assert.equal(rows[1]!.runId, 'run-old');
    assert.equal((rows[1]!.card as { title: string }).title, 'Old card 1');
    assert.equal(rows[2]!.runId, 'run-old');
    assert.equal((rows[2]!.card as { title: string }).title, 'Old card 2');
  });
});

test('listVisibleCards: skips runs that are not completed', async () => {
  await withTempHome(async () => {
    await seedCompletedRun('run-completed', [
      { id: 'run-completed_1', goalBasket: 'work', title: 'kept' },
    ]);
    // running run (no markCompleted)
    await savePipelineRunStart({
      runId: 'run-running',
      trigger: 'manual',
      subagentRunId: 'sub-running',
      subagentSessionKey: 'key-running',
    });
    // failed run
    await savePipelineRunStart({
      runId: 'run-failed',
      trigger: 'manual',
      subagentRunId: 'sub-failed',
      subagentSessionKey: 'key-failed',
    });
    await markPipelineRunFailed({ runId: 'run-failed', error: 'boom' });

    const rows = await listVisibleCards();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.runId, 'run-completed');
  });
});

test('listVisibleCards: same intent (basket+title) regenerated across runs returns multiple rows (no dedup)', async () => {
  await withTempHome(async () => {
    await seedCompletedRun('run-1', [
      { id: 'run-1_1', goalBasket: 'work', title: 'Plan PR review' },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    await seedCompletedRun('run-2', [
      { id: 'run-2_1', goalBasket: 'work', title: 'Plan PR review' },
    ]);

    const rows = await listVisibleCards();
    assert.equal(rows.length, 2, 'caller decides whether to dedup; backend keeps both');
    assert.equal(rows[0]!.runId, 'run-2');
    assert.equal(rows[1]!.runId, 'run-1');
  });
});

test('listVisibleCards: respects limit', async () => {
  await withTempHome(async () => {
    const cards = Array.from({ length: 5 }, (_, i) => ({
      id: `run-1_${i + 1}`,
      goalBasket: 'work',
      title: `card ${i + 1}`,
    }));
    await seedCompletedRun('run-1', cards);

    const rows = await listVisibleCards({ limit: 3 });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => (r.card as { title: string }).title),
      ['card 1', 'card 2', 'card 3'],
    );
  });
});

test('listVisibleCards: attaches scores from card_evaluations when available', async () => {
  await withTempHome(async () => {
    await seedCompletedRun('run-scored', [
      { id: 'card-A', goalBasket: 'work', title: 'A' },
      { id: 'card-B', goalBasket: 'work', title: 'B' },
    ]);
    await saveCardEvaluations([
      {
        cardId: 'card-A',
        runId: 'run-scored',
        intentKey: 'work/a',
        basket: 'work',
        overall: 8.2,
        pass: true,
      },
      // card-B has no evaluation row
    ]);

    const rows = await listVisibleCards();
    const a = rows.find((r) => (r.card as { id: string }).id === 'card-A');
    const b = rows.find((r) => (r.card as { id: string }).id === 'card-B');
    assert.ok(a);
    assert.ok(b);
    assert.deepEqual(a!.score, { overall: 8.2, pass: true });
    assert.equal(b!.score, null);
  });
});

test('listVisibleCards: returns empty when no completed runs exist', async () => {
  await withTempHome(async () => {
    const rows = await listVisibleCards();
    assert.deepEqual(rows, []);
  });
});
