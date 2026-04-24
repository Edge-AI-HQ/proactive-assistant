/**
 * Tests for the daily dreaming enqueuer. Covers the decision matrix:
 *   - setting off → no-op
 *   - past 06:00 + no dream today + setting on → enqueue
 *   - already enqueued today → returns the existing task id, no duplicate
 *   - dream completed earlier today → not_due
 *   - before 06:00 local → not_due
 *   - timezone resolution (profile timezone wins over system)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  completeEvolutionRun,
  createEvolutionRun,
  enqueueBackgroundTask,
  listBackgroundTasks,
  resetDbForTests,
  updateUserSettings,
  upsertProfile,
} from '../db.ts';
import { maybeEnqueueDailyDreaming } from './dreaming-enqueuer.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-dream-enq-'));
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

async function turnOnDreaming(): Promise<void> {
  await updateUserSettings({ auto_dreaming: true });
}

// noon UTC, which in UTC timezone is well past 06:00 and there's no
// prior dream completion → due
const NOON_UTC = new Date('2026-04-24T12:00:00Z');
// 04:00 UTC, before 06:00 in UTC timezone → not due
const EARLY_UTC = new Date('2026-04-24T04:00:00Z');

test('setting off → reason=setting_off, no task', async () => {
  await withTempHome(async () => {
    const r = await maybeEnqueueDailyDreaming({ now: NOON_UTC, timezoneOverride: 'UTC' });
    assert.equal(r.reason, 'setting_off');
    assert.equal((await listBackgroundTasks({ type: 'auto.dreaming' })).length, 0);
  });
});

test('happy path: setting on + past 06:00 + no prior dream → enqueued', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    const r = await maybeEnqueueDailyDreaming({
      now: NOON_UTC,
      timezoneOverride: 'UTC',
      lastAutoCompletedAtOverride: null,
    });
    assert.equal(r.reason, 'enqueued');
    assert.equal(r.localDay, '2026-04-24');
    assert.equal(r.timezone, 'UTC');
    assert.ok(r.taskId);
    const tasks = await listBackgroundTasks({ type: 'auto.dreaming', limit: 5 });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.idempotency_key, 'auto.dreaming:2026-04-24');
    assert.equal(tasks[0]!.priority, 30);
    assert.equal(tasks[0]!.max_attempts, 1);
    assert.equal(tasks[0]!.payload.trigger, 'auto');
    assert.equal(tasks[0]!.payload.localDay, '2026-04-24');
  });
});

test('idempotent: second sweep same day returns existing task id, no duplicate', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    const r1 = await maybeEnqueueDailyDreaming({
      now: NOON_UTC, timezoneOverride: 'UTC', lastAutoCompletedAtOverride: null,
    });
    const r2 = await maybeEnqueueDailyDreaming({
      now: NOON_UTC, timezoneOverride: 'UTC', lastAutoCompletedAtOverride: null,
    });
    assert.equal(r1.reason, 'enqueued');
    assert.equal(r2.reason, 'already_enqueued');
    assert.equal(r2.taskId, r1.taskId);
    assert.equal((await listBackgroundTasks({ type: 'auto.dreaming' })).length, 1);
  });
});

test('not_due: before 06:00 local time → no enqueue', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    const r = await maybeEnqueueDailyDreaming({
      now: EARLY_UTC, timezoneOverride: 'UTC', lastAutoCompletedAtOverride: null,
    });
    assert.equal(r.reason, 'not_due');
    assert.equal((await listBackgroundTasks({ type: 'auto.dreaming' })).length, 0);
  });
});

test('not_due: dream already completed earlier the SAME local day → no enqueue', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    // Previous dream completed at 09:00 UTC same day
    const earlierToday = new Date('2026-04-24T09:00:00Z').toISOString();
    const r = await maybeEnqueueDailyDreaming({
      now: NOON_UTC,
      timezoneOverride: 'UTC',
      lastAutoCompletedAtOverride: earlierToday,
    });
    assert.equal(r.reason, 'not_due');
  });
});

test('due: dream completed YESTERDAY → today is a fresh slot, enqueue', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    const yesterday = new Date('2026-04-23T18:00:00Z').toISOString();
    const r = await maybeEnqueueDailyDreaming({
      now: NOON_UTC,
      timezoneOverride: 'UTC',
      lastAutoCompletedAtOverride: yesterday,
    });
    assert.equal(r.reason, 'enqueued');
    assert.equal(r.localDay, '2026-04-24');
  });
});

test('local-day key uses profile timezone (Asia/Shanghai), not system', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    await upsertProfile({ displayName: 'Test', timezone: 'Asia/Shanghai' });
    // 22:00 UTC = 06:00 next day in Shanghai → due, but the local day is 04-25
    const utc22 = new Date('2026-04-24T22:00:00Z');
    const r = await maybeEnqueueDailyDreaming({
      now: utc22,
      lastAutoCompletedAtOverride: null,
      // no timezoneOverride — let the enqueuer read from profile
    });
    assert.equal(r.reason, 'enqueued');
    assert.equal(r.localDay, '2026-04-25');
    assert.equal(r.timezone, 'Asia/Shanghai');
    const tasks = await listBackgroundTasks({ type: 'auto.dreaming' });
    assert.equal(tasks[0]!.idempotency_key, 'auto.dreaming:2026-04-25');
  });
});

test('reads lastAutoCompletedAt from evolution_runs(trigger=daily_dream, status=completed) when no override', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    // Stage a completed evolution_run for an earlier moment same day
    const evo = await createEvolutionRun({ triggerKind: 'daily_dream' });
    await completeEvolutionRun(evo.id, { durationMs: 1000 });
    // The evo's completed_at is "now" (real wall clock), which on most CI
    // hosts is the same UTC day as NOON_UTC. So this should be 'not_due'
    // when paired with a same-day NOON_UTC (using UTC tz).
    // For determinism, pin "now" to just after the evo finished.
    const now = new Date(Date.now() + 5_000);
    const r = await maybeEnqueueDailyDreaming({
      now,
      timezoneOverride: 'UTC',
      // no lastAutoCompletedAtOverride — production code path
    });
    assert.equal(r.reason, 'not_due');
  });
});

test('preexisting auto.dreaming task for today (regardless of provenance) blocks new enqueue', async () => {
  await withTempHome(async () => {
    await turnOnDreaming();
    // Manual enqueue with the same idempotency key
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'auto.dreaming:2026-04-24',
      maxAttempts: 1,
      payload: { trigger: 'auto', localDay: '2026-04-24' },
    });
    const r = await maybeEnqueueDailyDreaming({
      now: NOON_UTC,
      timezoneOverride: 'UTC',
      lastAutoCompletedAtOverride: null,
    });
    assert.equal(r.reason, 'already_enqueued');
    assert.equal((await listBackgroundTasks({ type: 'auto.dreaming' })).length, 1);
  });
});
