/**
 * Tests for the Phase C auto.dreaming task handler. The actual dreaming
 * pipeline is dependency-injected via deps.dreamRunner so we can exercise
 * happy path / failure / lease-loss without spinning up agents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueueBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  resetDbForTests,
} from '../../db.ts';
import { BackgroundTaskScheduler } from '../scheduler.ts';
import { createAutoDreamingHandler } from './auto-dreaming.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-auto-dream-'));
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

async function runOneTickWith(deps: Parameters<typeof createAutoDreamingHandler>[0]) {
  const s = new BackgroundTaskScheduler({ workerId: 'test', leaseDurationMs: 60_000 });
  s.registerHandler('auto.dreaming', createAutoDreamingHandler(deps));
  await s.tick();
  const tasks = await listBackgroundTasks({ type: 'auto.dreaming', limit: 5 });
  return tasks[0]!;
}

test('happy path: dreamRunner returns runId → task succeeded with result', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'auto.dreaming:2026-04-24',
      maxAttempts: 1,
      payload: { trigger: 'auto', localDay: '2026-04-24' },
    });

    let called = 0;
    const task = await runOneTickWith({
      dreamRunner: async () => {
        called += 1;
        return { runId: 'dream-run-abc', candidatesGenerated: 3, durationMs: 1234 };
      },
    });
    assert.equal(called, 1);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result?.runId, 'dream-run-abc');
    assert.equal(task.result?.candidatesGenerated, 3);
    assert.equal(task.result?.durationMs, 1234);
  });
});

test('dreamRunner throws → task failed with errorCode=dream_failed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'fail',
      maxAttempts: 1,  // dream is expensive — no retry
      payload: { trigger: 'auto' },
    });
    const task = await runOneTickWith({
      dreamRunner: async () => { throw new Error('LLM timeout after 180s'); },
    });
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'dream_failed');
    assert.match(task.last_error_message ?? '', /LLM timeout/);
  });
});

test('handler with neither api nor dreamRunner → terminal failed (no_runtime)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'no-runtime',
      maxAttempts: 1,
      payload: { trigger: 'auto' },
    });
    const task = await runOneTickWith({});
    assert.equal(task.status, 'failed');
    assert.equal(task.last_error_code, 'no_runtime');
  });
});

test('max_attempts=1 + dream throws → task is terminal failed after 1 attempt (no requeue)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'no-retry',
      maxAttempts: 1,
      payload: { trigger: 'auto' },
    });
    let calls = 0;
    const dreamRunner = async () => { calls += 1; throw new Error('boom'); };
    const s = new BackgroundTaskScheduler({ workerId: 'w' });
    s.registerHandler('auto.dreaming', createAutoDreamingHandler({ dreamRunner }));
    await s.tick();
    await s.tick();  // would re-claim if retry was possible

    assert.equal(calls, 1);
    const tasks = await listBackgroundTasks({ type: 'auto.dreaming', limit: 5 });
    assert.equal(tasks[0]!.status, 'failed');
  });
});

test('result.candidatesGenerated defaults to 0 when dreamRunner omits it', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'no-cands',
      maxAttempts: 1,
      payload: { trigger: 'auto' },
    });
    const task = await runOneTickWith({
      dreamRunner: async () => ({ runId: 'r1' }),  // no candidatesGenerated
    });
    assert.equal(task.status, 'succeeded');
    assert.equal(task.result?.candidatesGenerated, 0);
    assert.equal(task.result?.runId, 'r1');
  });
});

test('handler heartbeats with extended lease before calling the dream', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'lease-extend',
      maxAttempts: 1,
      payload: { trigger: 'auto' },
    });
    let leaseAtCallTime: string | null = null;
    const dreamRunner = async () => {
      const tasks = await listBackgroundTasks({ type: 'auto.dreaming', limit: 1 });
      leaseAtCallTime = tasks[0]?.lease_expires_at ?? null;
      return { runId: 'r' };
    };
    const s = new BackgroundTaskScheduler({
      workerId: 'w',
      leaseDurationMs: 10_000,  // small initial lease
    });
    s.registerHandler('auto.dreaming', createAutoDreamingHandler({ dreamRunner }));
    await s.tick();
    // Lease was bumped to ~10 minutes by the heartbeat, so it should be
    // way later than now + 10s
    assert.ok(leaseAtCallTime);
    const fromNow = Date.parse(leaseAtCallTime!) - Date.now();
    assert.ok(fromNow > 60_000, `lease should be > 60s out, got ${fromNow}ms`);
  });
});

test('handler keeps heartbeating while dreamRunner is in flight', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey: 'lease-renew-while-running',
      maxAttempts: 1,
      payload: { trigger: 'auto' },
    });

    const s = new BackgroundTaskScheduler({
      workerId: 'w',
      leaseDurationMs: 10_000,
    });
    s.registerHandler('auto.dreaming', createAutoDreamingHandler({
      heartbeatIntervalMs: 5,
      dreamRunner: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { runId: 'r' };
      },
    }));

    await s.tick();

    const task = await getBackgroundTask((await listBackgroundTasks({ type: 'auto.dreaming', limit: 1 }))[0]!.id);
    assert.equal(task?.status, 'succeeded');
    const heartbeatCount = Number(task?.progress?.heartbeatCount ?? 0);
    assert.ok(heartbeatCount >= 1, `expected periodic heartbeat, got ${heartbeatCount}`);
  });
});
