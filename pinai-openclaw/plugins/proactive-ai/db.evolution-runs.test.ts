/**
 * Tests for v3 evolution_runs — unified ledger for dream / crystallize /
 * manual / consolidation runs.
 * See docs/plans/memory-architecture.mdx §三 (evolution_runs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  completeEvolutionRun,
  createEvolutionRun,
  failEvolutionRun,
  getEvolutionRun,
  listEvolutionRuns,
  recordEvolutionDelta,
  recordEvolutionRefsConsumed,
  recordEvolutionRefsProduced,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-evol-runs-'));
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

test('createEvolutionRun: starts in running status with default counters', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({
      triggerKind: 'daily_dream',
      windowStart: '2026-04-23T00:00:00Z',
      windowEnd: '2026-04-24T00:00:00Z',
      contextSummary: 'pulled 14 signals + 3 emails',
    });
    assert.equal(r.trigger_kind, 'daily_dream');
    assert.equal(r.status, 'running');
    assert.equal(r.memories_written, 0);
    assert.equal(r.profile_updated, false);
    assert.deepEqual(r.refs_consumed, {});
    assert.deepEqual(r.refs_produced, {});
    assert.ok(r.started_at);
    assert.equal(r.completed_at, null);
  });
});

test('recordEvolutionDelta: bumps counters cumulatively', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'chat_burst' });
    await recordEvolutionDelta(r.id, { memoriesWritten: 2, skillsAdded: 1 });
    await recordEvolutionDelta(r.id, { memoriesWritten: 3, signalsConsumed: 5 });
    const after = await getEvolutionRun(r.id);
    assert.equal(after!.memories_written, 5);
    assert.equal(after!.skills_added, 1);
    assert.equal(after!.signals_consumed, 5);
  });
});

test('recordEvolutionDelta: profile_updated + profile_changed_keys replace', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'manual' });
    await recordEvolutionDelta(r.id, {
      profileUpdated: true,
      profileChangedKeys: ['summary', 'attributes.job'],
    });
    const after = await getEvolutionRun(r.id);
    assert.equal(after!.profile_updated, true);
    assert.deepEqual(after!.profile_changed_keys, ['summary', 'attributes.job']);

    // Subsequent call replaces, not merges
    await recordEvolutionDelta(r.id, { profileChangedKeys: ['summary'] });
    const after2 = await getEvolutionRun(r.id);
    assert.deepEqual(after2!.profile_changed_keys, ['summary']);
  });
});

test('recordEvolutionRefsConsumed: dedupes per-table ids', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'daily_dream' });
    await recordEvolutionRefsConsumed(r.id, 'personal_signals', ['s1', 's2']);
    await recordEvolutionRefsConsumed(r.id, 'personal_signals', ['s2', 's3']);
    await recordEvolutionRefsConsumed(r.id, 'gmail_messages', ['gm1']);
    const after = await getEvolutionRun(r.id);
    assert.deepEqual(after!.refs_consumed.personal_signals.sort(), ['s1', 's2', 's3']);
    assert.deepEqual(after!.refs_consumed.gmail_messages, ['gm1']);
  });
});

test('recordEvolutionRefsProduced: same dedupe semantics', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'daily_dream' });
    await recordEvolutionRefsProduced(r.id, 'memory', ['m1', 'm2']);
    await recordEvolutionRefsProduced(r.id, 'memory', ['m2']);
    await recordEvolutionRefsProduced(r.id, 'skill_index', ['s1']);
    const after = await getEvolutionRun(r.id);
    assert.deepEqual(after!.refs_produced.memory.sort(), ['m1', 'm2']);
    assert.deepEqual(after!.refs_produced.skill_index, ['s1']);
  });
});

test('completeEvolutionRun: sets status, completed_at, llm_tokens, duration_ms', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'daily_dream' });
    const done = await completeEvolutionRun(r.id, { llmTokens: 1234, durationMs: 5678 });
    assert.equal(done.status, 'completed');
    assert.ok(done.completed_at);
    assert.equal(done.llm_tokens, 1234);
    assert.equal(done.duration_ms, 5678);
  });
});

test('failEvolutionRun: sets status=failed and stores error_message', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'manual' });
    const failed = await failEvolutionRun(r.id, 'LLM timeout');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_message, 'LLM timeout');
    assert.ok(failed.completed_at);
  });
});

test('listEvolutionRuns: filters by trigger / status / since; orders by started DESC', async () => {
  await withTempHome(async () => {
    const a = await createEvolutionRun({ triggerKind: 'chat_burst' });
    const b = await createEvolutionRun({ triggerKind: 'daily_dream' });
    const c = await createEvolutionRun({ triggerKind: 'daily_dream' });
    await failEvolutionRun(a.id, 'oops');
    await completeEvolutionRun(b.id);

    const dreams = await listEvolutionRuns({ triggerKind: 'daily_dream' });
    assert.equal(dreams.length, 2);

    const completed = await listEvolutionRuns({ status: 'completed' });
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.id, b.id);

    const failedOnly = await listEvolutionRuns({ status: 'failed' });
    assert.equal(failedOnly.length, 1);
    assert.equal(failedOnly[0]!.id, a.id);

    const all = await listEvolutionRuns();
    assert.equal(all.length, 3);
    // All three should be present; we don't assert specific ordering since
    // rapid-fire creates can share a millisecond timestamp.
    const ids = new Set(all.map((r) => r.id));
    assert.ok(ids.has(a.id) && ids.has(b.id) && ids.has(c.id));
  });
});

test('createEvolutionRun: rejects unknown trigger kind via DB CHECK', async () => {
  await withTempHome(async () => {
    await assert.rejects(
      createEvolutionRun({ triggerKind: 'rocket-launch' as any }),
      /CHECK constraint failed/,
    );
  });
});

test('recordEvolutionDelta: unknown runId is silently skipped (no UPDATE matches)', async () => {
  await withTempHome(async () => {
    // Should not throw
    await recordEvolutionDelta('does-not-exist', { memoriesWritten: 5 });
    assert.equal(await getEvolutionRun('does-not-exist'), null);
  });
});

test('recordEvolutionRefsConsumed/Produced: empty ids is a no-op', async () => {
  await withTempHome(async () => {
    const r = await createEvolutionRun({ triggerKind: 'manual' });
    await recordEvolutionRefsConsumed(r.id, 'memory', []);
    await recordEvolutionRefsProduced(r.id, '', ['x']); // empty table also no-op
    const after = await getEvolutionRun(r.id);
    assert.deepEqual(after!.refs_consumed, {});
    assert.deepEqual(after!.refs_produced, {});
  });
});
