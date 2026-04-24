/**
 * Tests for background_tasks — durable task queue with lease/heartbeat.
 * See docs/plans/2026-04-24-data-connector-init-tasks.mdx (Phase A).
 *
 * Coverage:
 *   - enqueue idempotency (same key returns existing row, never duplicates)
 *   - claim is atomic (one of two concurrent claims wins, the other gets null)
 *   - heartbeat enforces lease (wrong token → false; correct → extends)
 *   - complete/fail enforce lease the same way
 *   - failBackgroundTask requeues with backoff until max_attempts, then 'failed'
 *   - recoverStaleBackgroundTasks: expired-lease running rows go back to queued
 *     (or 'timed_out' when attempts exhausted) + attempt audit row marked 'lost'
 *   - cancel transitions queued/running → cancelled and is no-op on terminal
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cancelBackgroundTask,
  claimNextDueBackgroundTask,
  completeBackgroundTask,
  enqueueBackgroundTask,
  failBackgroundTask,
  getBackgroundTask,
  getBackgroundTaskByIdempotencyKey,
  heartbeatBackgroundTask,
  listBackgroundTasks,
  listTaskAttempts,
  recoverStaleBackgroundTasks,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-bg-tasks-'));
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

test('enqueue: creates a queued task with payload + defaults', async () => {
  await withTempHome(async () => {
    const { task, created } = await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'connector.init:gmail:acc-1:v1',
      payload: { toolkit: 'gmail', limit: 100 },
    });
    assert.equal(created, true);
    assert.equal(task.type, 'connector.init');
    assert.equal(task.status, 'queued');
    assert.equal(task.attempts, 0);
    assert.equal(task.max_attempts, 3);
    assert.equal(task.priority, 50);
    assert.deepEqual(task.payload, { toolkit: 'gmail', limit: 100 });
    assert.equal(task.lease_token, null);
    assert.ok(task.run_after);
    assert.ok(task.created_at);
  });
});

test('enqueue: same idempotency key returns existing row, no duplicate', async () => {
  await withTempHome(async () => {
    const a = await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'k1',
      payload: { round: 1 },
    });
    const b = await enqueueBackgroundTask({
      type: 'connector.init',
      idempotencyKey: 'k1',
      payload: { round: 2 },
    });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.task.id, a.task.id);
    // payload is NOT overwritten — that would be a silent mutation
    assert.deepEqual(b.task.payload, { round: 1 });

    const list = await listBackgroundTasks({ type: 'connector.init' });
    assert.equal(list.length, 1);
  });
});

test('enqueue: missing type or idempotency key throws', async () => {
  await withTempHome(async () => {
    await assert.rejects(
      enqueueBackgroundTask({ type: '', idempotencyKey: 'k' } as any),
      /type is required/,
    );
    await assert.rejects(
      enqueueBackgroundTask({ type: 't', idempotencyKey: '' } as any),
      /idempotencyKey is required/,
    );
  });
});

test('claim: picks highest-priority due task, transitions to running, writes attempt', async () => {
  await withTempHome(async () => {
    const low = await enqueueBackgroundTask({
      type: 'connector.init', idempotencyKey: 'low', priority: 100,
    });
    const high = await enqueueBackgroundTask({
      type: 'connector.init', idempotencyKey: 'high', priority: 10,
    });
    const claimed = await claimNextDueBackgroundTask({
      workerId: 'host:1:boot1', leaseDurationMs: 10_000,
    });
    assert.ok(claimed);
    // low priority number wins (10 < 100)
    assert.equal(claimed!.task.id, high.task.id);
    assert.equal(claimed!.task.status, 'running');
    assert.equal(claimed!.task.attempts, 1);
    assert.equal(claimed!.task.lease_owner, 'host:1:boot1');
    assert.ok(claimed!.task.lease_token);
    assert.ok(claimed!.task.lease_expires_at);
    assert.ok(claimed!.task.started_at);

    const attempts = await listTaskAttempts(high.task.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, 'running');
    assert.equal(attempts[0]!.attempt_no, 1);
    assert.equal(attempts[0]!.lease_token, claimed!.task.lease_token);

    // The lower-priority task should remain queued
    const after = await getBackgroundTask(low.task.id);
    assert.equal(after!.status, 'queued');
  });
});

test('claim: only returns due tasks (run_after > now is held back)', async () => {
  await withTempHome(async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await enqueueBackgroundTask({
      type: 'connector.init', idempotencyKey: 'future', runAfter: future,
    });
    const result = await claimNextDueBackgroundTask({ workerId: 'w1' });
    assert.equal(result, null);
  });
});

test('claim: returns null when nothing is due', async () => {
  await withTempHome(async () => {
    const result = await claimNextDueBackgroundTask({ workerId: 'w1' });
    assert.equal(result, null);
  });
});

test('claim: type filter restricts which tasks can be claimed', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 'auto.dreaming', idempotencyKey: 'd1' });
    await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'c1' });
    const claimed = await claimNextDueBackgroundTask({
      workerId: 'w1', types: ['connector.init'],
    });
    assert.ok(claimed);
    assert.equal(claimed!.task.type, 'connector.init');
  });
});

test('claim: two concurrent claims — only one wins', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'one' });
    // better-sqlite3 is sync, so genuine concurrency in-process means
    // back-to-back. The second call MUST see the row already claimed.
    const a = await claimNextDueBackgroundTask({ workerId: 'A' });
    const b = await claimNextDueBackgroundTask({ workerId: 'B' });
    assert.ok(a);
    assert.equal(b, null);
  });
});

test('heartbeat: correct lease extends; wrong lease returns false', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'hb' });
    const claim = await claimNextDueBackgroundTask({
      workerId: 'w1', leaseDurationMs: 1_000,
    });
    assert.ok(claim);
    const originalExpiry = claim!.task.lease_expires_at!;

    // Simulated handler progress + lease bump 1s later
    const ok = await heartbeatBackgroundTask({
      id: claim!.task.id,
      leaseToken: claim!.task.lease_token!,
      leaseDurationMs: 60_000,
      progress: { stage: 'fetch', got: 42 },
      nowOverride: new Date(Date.parse(originalExpiry) + 500).toISOString(),
    });
    assert.equal(ok, true);

    const after = await getBackgroundTask(claim!.task.id);
    assert.equal(after!.status, 'running');
    assert.deepEqual(after!.progress, { stage: 'fetch', got: 42 });
    assert.ok(after!.lease_expires_at! > originalExpiry);

    const wrongToken = await heartbeatBackgroundTask({
      id: claim!.task.id, leaseToken: 'not-the-real-token',
    });
    assert.equal(wrongToken, false);
  });
});

test('complete: only the holder of the lease can complete; lost lease returns false', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'c' });
    const claim = await claimNextDueBackgroundTask({ workerId: 'w1' });
    assert.ok(claim);

    const wrong = await completeBackgroundTask({
      id: claim!.task.id, leaseToken: 'no', result: { x: 1 },
    });
    assert.equal(wrong, false);

    const ok = await completeBackgroundTask({
      id: claim!.task.id, leaseToken: claim!.task.lease_token!,
      result: { ok: true, items: 12 },
    });
    assert.equal(ok, true);

    const after = await getBackgroundTask(claim!.task.id);
    assert.equal(after!.status, 'succeeded');
    assert.equal(after!.lease_token, null);
    assert.equal(after!.lease_owner, null);
    assert.deepEqual(after!.result, { ok: true, items: 12 });
    assert.ok(after!.completed_at);

    const attempts = await listTaskAttempts(claim!.task.id);
    assert.equal(attempts[0]!.status, 'succeeded');
    assert.ok(attempts[0]!.finished_at);
  });
});

test('fail: requeues with backoff while attempts < max_attempts', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'r', maxAttempts: 3,
    });

    const c1 = await claimNextDueBackgroundTask({ workerId: 'w' });
    const f1 = await failBackgroundTask({
      id: c1!.task.id, leaseToken: c1!.task.lease_token!,
      errorCode: 'composio_500', errorMessage: 'first',
      backoffMs: 0,  // skip backoff for test speed
    });
    assert.ok(f1);
    assert.equal(f1!.status, 'queued');
    assert.equal(f1!.attempts, 1);
    assert.equal(f1!.last_error_code, 'composio_500');
    assert.equal(f1!.lease_token, null);

    const c2 = await claimNextDueBackgroundTask({ workerId: 'w' });
    assert.ok(c2);
    assert.equal(c2!.task.attempts, 2);
    const f2 = await failBackgroundTask({
      id: c2!.task.id, leaseToken: c2!.task.lease_token!,
      errorCode: 'composio_500', errorMessage: 'second',
      backoffMs: 0,
    });
    assert.equal(f2!.status, 'queued');
    assert.equal(f2!.attempts, 2);

    const c3 = await claimNextDueBackgroundTask({ workerId: 'w' });
    assert.ok(c3);
    assert.equal(c3!.task.attempts, 3);
    const f3 = await failBackgroundTask({
      id: c3!.task.id, leaseToken: c3!.task.lease_token!,
      errorCode: 'composio_500', errorMessage: 'final',
      backoffMs: 0,
    });
    // attempts == max_attempts → terminal
    assert.equal(f3!.status, 'failed');
    assert.equal(f3!.attempts, 3);
    assert.ok(f3!.completed_at);

    // Subsequent claim returns null — terminal task is no longer eligible
    const c4 = await claimNextDueBackgroundTask({ workerId: 'w' });
    assert.equal(c4, null);
  });
});

test('fail: wrong lease token returns null without mutating state', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'wlf' });
    const c = await claimNextDueBackgroundTask({ workerId: 'w' });
    const result = await failBackgroundTask({
      id: c!.task.id, leaseToken: 'bogus',
      errorCode: 'x', errorMessage: 'y', backoffMs: 0,
    });
    assert.equal(result, null);
    const after = await getBackgroundTask(c!.task.id);
    assert.equal(after!.status, 'running');
    assert.equal(after!.last_error_code, null);
  });
});

test('recoverStale: expired lease + attempts left → requeued + attempt marked lost', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'stale', maxAttempts: 3,
    });
    const c = await claimNextDueBackgroundTask({
      workerId: 'crasher', leaseDurationMs: 1_000,
    });
    assert.ok(c);

    // Pretend 5s have passed — lease is expired
    const future = new Date(Date.parse(c!.task.lease_expires_at!) + 5_000).toISOString();
    const result = await recoverStaleBackgroundTasks({
      nowOverride: future, backoffMs: 0,
    });
    assert.equal(result.requeued, 1);
    assert.equal(result.timedOut, 0);

    const after = await getBackgroundTask(c!.task.id);
    assert.equal(after!.status, 'queued');
    assert.equal(after!.attempts, 1);  // attempts was bumped at claim, NOT decremented
    assert.equal(after!.lease_token, null);
    assert.equal(after!.last_error_code, 'lease_expired');

    const attempts = await listTaskAttempts(c!.task.id);
    assert.equal(attempts[0]!.status, 'lost');
    assert.equal(attempts[0]!.error_code, 'lease_expired');
  });
});

test('recoverStale: expired lease + attempts exhausted → timed_out terminal', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'exhaust', maxAttempts: 1,
    });
    const c = await claimNextDueBackgroundTask({
      workerId: 'w', leaseDurationMs: 1_000,
    });
    assert.ok(c);
    assert.equal(c!.task.attempts, 1);  // already at max

    const future = new Date(Date.parse(c!.task.lease_expires_at!) + 5_000).toISOString();
    const result = await recoverStaleBackgroundTasks({
      nowOverride: future, backoffMs: 0,
    });
    assert.equal(result.requeued, 0);
    assert.equal(result.timedOut, 1);

    const after = await getBackgroundTask(c!.task.id);
    assert.equal(after!.status, 'timed_out');
    assert.ok(after!.completed_at);
  });
});

test('recoverStale: only running rows past lease are touched (queued/succeeded untouched)', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'q-untouched' });
    const live = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'live',
    });
    const cl = await claimNextDueBackgroundTask({
      workerId: 'w', leaseDurationMs: 60_000,
    });
    // cl might be either; just check that recover with current time touches nothing
    assert.ok(cl);
    const result = await recoverStaleBackgroundTasks({});
    assert.equal(result.requeued, 0);
    assert.equal(result.timedOut, 0);
  });
});

test('cancel: queued task → cancelled', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'cncl' });
    const ok = await cancelBackgroundTask(e.task.id);
    assert.equal(ok, true);
    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'cancelled');
  });
});

test('cancel: running task → cancelled; subsequent heartbeat returns false', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'cncl-r' });
    const c = await claimNextDueBackgroundTask({ workerId: 'w' });
    assert.ok(c);
    await cancelBackgroundTask(e.task.id);
    const hb = await heartbeatBackgroundTask({
      id: e.task.id, leaseToken: c!.task.lease_token!,
    });
    assert.equal(hb, false);
  });
});

test('cancel: terminal task is a no-op (returns false)', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'term' });
    const c = await claimNextDueBackgroundTask({ workerId: 'w' });
    await completeBackgroundTask({
      id: e.task.id, leaseToken: c!.task.lease_token!,
    });
    const ok = await cancelBackgroundTask(e.task.id);
    assert.equal(ok, false);
    const after = await getBackgroundTask(e.task.id);
    assert.equal(after!.status, 'succeeded');
  });
});

test('list: filters by type and status, orders by created_at DESC', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 'a', idempotencyKey: 'a1' });
    await enqueueBackgroundTask({ type: 'a', idempotencyKey: 'a2' });
    await enqueueBackgroundTask({ type: 'b', idempotencyKey: 'b1' });
    const c = await claimNextDueBackgroundTask({ workerId: 'w' });
    await failBackgroundTask({
      id: c!.task.id, leaseToken: c!.task.lease_token!,
      errorCode: 'x', errorMessage: 'y', backoffMs: 0,
    });

    const onlyA = await listBackgroundTasks({ type: 'a' });
    assert.equal(onlyA.length, 2);
    assert.ok(onlyA.every((t) => t.type === 'a'));

    const queuedAll = await listBackgroundTasks({ status: 'queued' });
    assert.equal(queuedAll.length, 3);

    const queuedOrSucceeded = await listBackgroundTasks({
      status: ['queued', 'succeeded'],
    });
    assert.equal(queuedOrSucceeded.length, 3);
  });
});

test('getBackgroundTaskByIdempotencyKey: round-trip lookup', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 't', idempotencyKey: 'unique-key-42',
    });
    const lookup = await getBackgroundTaskByIdempotencyKey('unique-key-42');
    assert.ok(lookup);
    assert.equal(lookup!.id, e.task.id);
    assert.equal(await getBackgroundTaskByIdempotencyKey('missing'), null);
  });
});

test('CHECK constraint: invalid status is rejected by the DB', async () => {
  // Status enum lives in the schema CHECK; if a future patch adds a status
  // without updating the CHECK clause, this test surfaces it immediately.
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'chk' });
    const Database = (await import('better-sqlite3')).default;
    const path = (await import('node:path')).default;
    const dbPath = path.join(process.env.OPENCLAW_HOME!, 'data', 'proactive.db');
    // Use a separate handle so we bypass the singleton's prepared statements.
    const handle = new Database(dbPath);
    try {
      assert.throws(
        () => handle.prepare(
          "UPDATE background_tasks SET status = 'wat' WHERE id = ?",
        ).run(e.task.id),
        /CHECK constraint failed/,
      );
    } finally {
      handle.close();
    }
  });
});
