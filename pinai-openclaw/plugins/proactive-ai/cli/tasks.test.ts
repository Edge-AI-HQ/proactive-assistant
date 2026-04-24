/**
 * Tests for `pin tasks` CLI surface.
 *
 * The CLI wraps the background_tasks repository directly (no scheduler in
 * the loop). Tests pin envelope shapes so v3-review-fixes can rely on
 * them, and exercise the validation paths so a bad `--status` doesn't
 * silently match nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleTasks } from './tasks.ts';
import {
  enqueueBackgroundTask,
  claimNextDueBackgroundTask,
  resetDbForTests,
} from '../db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-cli-tasks-'));
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

function decode(raw: string): { ok: boolean; data: any; error: any; meta: any } {
  return JSON.parse(raw);
}

test('pin tasks help: lists subcommands', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['help']));
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.data.commands.sort(),
      ['attempts', 'cancel', 'enqueue', 'list', 'show'],
    );
    assert.ok(Array.isArray(r.data.examples));
  });
});

test('pin tasks: empty args defaults to help', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks([]));
    assert.equal(r.ok, true);
    assert.equal(r.meta.command, 'help');
  });
});

test('pin tasks list: empty queue → count=0', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['list']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 0);
    assert.deepEqual(r.data.tasks, []);
  });
});

test('pin tasks list: filters by --type and --status, --limit caps results', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'a' });
    await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'b' });
    await enqueueBackgroundTask({ type: 'auto.dreaming', idempotencyKey: 'c' });

    const onlyInit = decode(await handleTasks(['list', '--type', 'connector.init']));
    assert.equal(onlyInit.data.count, 2);

    const queued = decode(await handleTasks(['list', '--status', 'queued']));
    assert.equal(queued.data.count, 3);

    const limited = decode(await handleTasks(['list', '--limit', '1']));
    assert.equal(limited.data.count, 1);
  });
});

test('pin tasks list: comma-separated --status accepts multiple', async () => {
  await withTempHome(async () => {
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'k1' });
    await enqueueBackgroundTask({ type: 't', idempotencyKey: 'k2' });
    const r = decode(await handleTasks(['list', '--status', 'queued,running,succeeded']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 2);
  });
});

test('pin tasks list: invalid --status returns validation error', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['list', '--status', 'wat']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.match(r.error.message, /Invalid --status/);
  });
});

test('pin tasks list: bad --limit (NaN) returns validation error', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['list', '--limit', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin tasks show: known id returns full row', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({
      type: 'connector.init', idempotencyKey: 'show-me',
      payload: { toolkit: 'gmail' }, priority: 10,
    });
    const r = decode(await handleTasks(['show', '--id', e.task.id]));
    assert.equal(r.ok, true);
    assert.equal(r.data.task.id, e.task.id);
    assert.equal(r.data.task.type, 'connector.init');
    assert.deepEqual(r.data.task.payload, { toolkit: 'gmail' });
  });
});

test('pin tasks show: unknown id returns not_found', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['show', '--id', 'no-such-task']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NOT_FOUND');
  });
});

test('pin tasks show: missing --id returns validation', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['show']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin tasks attempts: returns audit history after a claim', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'aud' });
    await claimNextDueBackgroundTask({ workerId: 'w1' });
    const r = decode(await handleTasks(['attempts', '--id', e.task.id]));
    assert.equal(r.ok, true);
    assert.equal(r.data.taskId, e.task.id);
    assert.equal(r.data.count, 1);
    assert.equal(r.data.attempts[0].status, 'running');
    assert.equal(r.data.attempts[0].worker_id, 'w1');
  });
});

test('pin tasks attempts: unknown id returns not_found', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['attempts', '--id', 'nope']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NOT_FOUND');
  });
});

test('pin tasks cancel: queued task → cancelled', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'cn' });
    const r = decode(await handleTasks(['cancel', '--id', e.task.id]));
    assert.equal(r.ok, true);
    assert.equal(r.data.status, 'cancelled');
  });
});

test('pin tasks cancel: terminal task → conflict', async () => {
  await withTempHome(async () => {
    const e = await enqueueBackgroundTask({ type: 't', idempotencyKey: 'cn2' });
    await handleTasks(['cancel', '--id', e.task.id]);
    const r = decode(await handleTasks(['cancel', '--id', e.task.id]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'CONFLICT');
  });
});

test('pin tasks cancel: unknown id → not_found', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['cancel', '--id', 'missing']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NOT_FOUND');
  });
});

test('pin tasks enqueue: creates a task and returns id+created=true', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks([
      'enqueue',
      '--type', 'connector.init',
      '--idempotencyKey', 'gmail:a:v1',
      '--payload', '{"toolkit":"gmail","limit":100}',
      '--priority', '10',
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.data.created, true);
    assert.ok(r.data.id);
    assert.equal(r.data.task.type, 'connector.init');
    assert.equal(r.data.task.priority, 10);
    assert.deepEqual(r.data.task.payload, { toolkit: 'gmail', limit: 100 });
  });
});

test('pin tasks enqueue: same idempotency key returns created=false', async () => {
  await withTempHome(async () => {
    await handleTasks(['enqueue', '--type', 't', '--idempotencyKey', 'k']);
    const r = decode(await handleTasks(['enqueue', '--type', 't', '--idempotencyKey', 'k']));
    assert.equal(r.ok, true);
    assert.equal(r.data.created, false);
  });
});

test('pin tasks enqueue: missing --type or --idempotencyKey → validation', async () => {
  await withTempHome(async () => {
    const r1 = decode(await handleTasks(['enqueue', '--idempotencyKey', 'k']));
    assert.equal(r1.ok, false);
    assert.equal(r1.error.code, 'VALIDATION');
    const r2 = decode(await handleTasks(['enqueue', '--type', 't']));
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'VALIDATION');
  });
});

test('pin tasks enqueue: malformed --payload JSON → validation', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks([
      'enqueue', '--type', 't', '--idempotencyKey', 'k', '--payload', '{not json',
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin tasks: unknown subcommand → validation', async () => {
  await withTempHome(async () => {
    const r = decode(await handleTasks(['nonexistent']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});
