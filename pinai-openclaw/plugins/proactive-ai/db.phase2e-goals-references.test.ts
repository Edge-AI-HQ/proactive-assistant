/**
 * Phase 2e — goals stay first-class but get the v3 reference triple
 * (reference_count + last_referenced_at + referenced_by_runs[≤10]) so
 * the dream agent (and future consolidation passes) can mark which
 * goals each evolution run touched.
 *
 * This file pins down the new column shape, the ensureColumn migration,
 * the markGoalsReferenced helper's idempotent capped-list semantics, and
 * the dreaming integration (write-through dream stamps both the
 * evolution_run.refs_produced.goals AND bumps the goals reference
 * triple in the same transaction).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  upsertGoal,
  closeGoal,
  listGoals,
  markGoalsReferenced,
  resetDbForTests,
  upsertProfile,
  listEvolutionRuns,
} from './db.ts';
import { runDreaming } from './dreaming/service.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-phase2e-'));
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

const DREAM_SYNTHESIS_FIXTURE = {
  summary: { kind: 'updated', text: 'Quiet day', highlights: [] },
  candidateCards: [],
  journalMarkdown: '# Dream',
  interestTopics: [],
  goalDelta: {
    changes: [
      { action: 'create', key: 'morning-routine', reason: 'observed', before: null, after: { title: 'Establish morning routine', priority: 'medium' } },
      { action: 'create', key: 'gym-3x-week', reason: 'pattern', before: null, after: { title: 'Hit the gym 3x/week', priority: 'high' } },
    ],
  },
};

function makeDreamingApi(synthesis: Record<string, unknown> = DREAM_SYNTHESIS_FIXTURE) {
  const fenced = '```json\n' + JSON.stringify(synthesis) + '\n```';
  return {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    runtime: {
      subagent: {
        run: async () => ({ runId: `run-${Date.now()}` }),
        waitForRun: async () => ({ status: 'ok' as const }),
        getSessionMessages: async () => ({ messages: [{ role: 'assistant', content: fenced }] }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

// ── 1. Schema migration: existing goals tables get the new columns ──────

test('goals row exposes the v3 reference triple after ensureColumn migration',
  withTempHome(async () => {
    const g = await upsertGoal({ key: 'demo', title: 'Demo goal' });
    assert.equal(g.reference_count, 0);
    assert.equal(g.last_referenced_at, null);
    assert.deepEqual(g.referenced_by_runs, []);
  }));

// ── 2. markGoalsReferenced semantics ─────────────────────────────────────

test('markGoalsReferenced bumps reference_count + appends runId, caps at 10',
  withTempHome(async () => {
    await upsertGoal({ key: 'k1', title: 'g1' });
    await upsertGoal({ key: 'k2', title: 'g2' });

    await markGoalsReferenced(['k1', 'k2'], 'run_1');
    let goals = await listGoals();
    const byKey = new Map(goals.map((g) => [g.key, g]));
    assert.equal(byKey.get('k1')!.reference_count, 1);
    assert.deepEqual(byKey.get('k1')!.referenced_by_runs, ['run_1']);
    assert.deepEqual(byKey.get('k2')!.referenced_by_runs, ['run_1']);

    // Same runId again should NOT duplicate, but should still bump count
    // (the dream cycle re-mentioning a goal is real evidence even if it's
    // the same evolution_run).
    await markGoalsReferenced(['k1'], 'run_1');
    goals = await listGoals();
    const k1 = goals.find((g) => g.key === 'k1')!;
    assert.equal(k1.reference_count, 2, 'count bumps even on same runId');
    assert.deepEqual(k1.referenced_by_runs, ['run_1'], 'list deduped');

    // 12 distinct runs → list capped at 10, count keeps going.
    for (let i = 2; i <= 12; i++) {
      await markGoalsReferenced(['k1'], `run_${i}`);
    }
    const final = (await listGoals()).find((g) => g.key === 'k1')!;
    assert.equal(final.reference_count, 13);
    assert.equal(final.referenced_by_runs.length, 10, 'list capped at 10');
    assert.equal(final.referenced_by_runs[0], 'run_12', 'newest first');
    assert.equal(final.referenced_by_runs[9], 'run_3', 'oldest in window');
    assert.equal(final.referenced_by_runs.includes('run_1'), false, 'dropped past cap');
    assert.equal(final.referenced_by_runs.includes('run_2'), false, 'dropped past cap');
  }));

test('markGoalsReferenced no-op on missing keys', withTempHome(async () => {
  await upsertGoal({ key: 'real', title: 'real goal' });
  await markGoalsReferenced(['real', 'no_such_goal'], 'run_x');
  const real = (await listGoals()).find((g) => g.key === 'real')!;
  assert.equal(real.reference_count, 1);
}));

test('markGoalsReferenced empty list is a no-op', withTempHome(async () => {
  await upsertGoal({ key: 'g', title: 'g' });
  await markGoalsReferenced([], 'run_x');
  const g = (await listGoals()).find((x) => x.key === 'g')!;
  assert.equal(g.reference_count, 0);
}));

// ── 3. dreaming integration: dream → goal references bumped ──────────────

test('runDreaming bumps goal reference triple for every goal it touches',
  withTempHome(async () => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    const { run } = await runDreaming({
      api: makeDreamingApi(DREAM_SYNTHESIS_FIXTURE),
      trigger: 'auto',
    });
    assert.equal(run.status, 'completed');

    // Both goals exist and have reference_count == 1 stamped by the dream.
    const goals = await listGoals();
    const byKey = new Map(goals.map((g) => [g.key, g]));
    const morning = byKey.get('morning-routine')!;
    const gym = byKey.get('gym-3x-week')!;
    assert.ok(morning, 'dream created the morning-routine goal');
    assert.ok(gym, 'dream created the gym-3x-week goal');

    // Dream id is also the evolution_run id (Phase 2d).
    const evol = (await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 1 }))[0]!;
    assert.equal(morning.reference_count, 1);
    assert.deepEqual(morning.referenced_by_runs, [evol.id]);
    assert.equal(gym.reference_count, 1);
    assert.deepEqual(gym.referenced_by_runs, [evol.id]);

    // The evolution_run mirror still records the same set under refs_produced.
    assert.deepEqual((evol.refs_produced.goals ?? []).sort(), ['gym-3x-week', 'morning-routine']);
  }));

test('closeGoal preserves the reference triple', withTempHome(async () => {
  await upsertGoal({ key: 'k', title: 'g' });
  await markGoalsReferenced(['k'], 'r1');
  await closeGoal('k');
  // closed goals don't appear in listGoals (active-only); fetch directly.
  // closeGoal returns the row.
  const closed = await closeGoal('k');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.reference_count, 1);
  assert.deepEqual(closed.referenced_by_runs, ['r1']);
}));
