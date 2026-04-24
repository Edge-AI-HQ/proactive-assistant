/**
 * HTTP-level tests for /tasks/:id and /tasks (read-only).
 *
 * Used by the Data Connections UI to poll a connector.init task after
 * /composio/wait returns initTaskId. This test pins the response shape
 * so the UI can rely on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleTasks } from './tasks.ts';
import {
  enqueueBackgroundTask,
  resetDbForTests,
} from '../db.ts';

function createRequest(method: string) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  req.end();
  return req;
}

function createResponse() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(s: number, h: Record<string, string>) { r.statusCode = s; r.headers = h; return r; },
    end(c?: string) { if (c) r.body += c; return r; },
  };
  return r;
}

function makeCtx(method: string, subpath: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${subpath}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = createResponse();
  return {
    ctx: {
      subpath,
      req: createRequest(method),
      res,
      url,
      api: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    } as never,
    res,
  };
}

function withTempHome(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-tasks-route-'));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    try {
      await fn();
    } finally {
      resetDbForTests();
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function decode(body: string): any {
  return JSON.parse(body);
}

// ──────────────────────────────────────────────────────────────────────
// GET /tasks/:id
// ──────────────────────────────────────────────────────────────────────

test('GET /tasks/:id (known) → 200 with task envelope', withTempHome(async () => {
  const e = await enqueueBackgroundTask({
    type: 'connector.init',
    idempotencyKey: 'connector.init:gmail:acc-1:v1',
    payload: { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 100 },
  });
  const { ctx, res } = makeCtx('GET', `/tasks/${e.task.id}`);
  const handled = await handleTasks()(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = decode(res.body);
  assert.equal(body.task.id, e.task.id);
  assert.equal(body.task.type, 'connector.init');
  assert.equal(body.task.status, 'queued');
  assert.deepEqual(body.task.payload, { toolkit: 'gmail', connectedAccountId: 'acc-1', limit: 100 });
}));

test('GET /tasks/:id (unknown) → 404', withTempHome(async () => {
  const { ctx, res } = makeCtx('GET', '/tasks/missing-task-id');
  const handled = await handleTasks()(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  const body = decode(res.body);
  assert.match(body.error, /not found/i);
}));

test('GET /tasks/ (empty id after slash) → 400', withTempHome(async () => {
  const { ctx, res } = makeCtx('GET', '/tasks/');
  const handled = await handleTasks()(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(decode(res.body).error, /Missing task id/);
}));

// ──────────────────────────────────────────────────────────────────────
// GET /tasks (list)
// ──────────────────────────────────────────────────────────────────────

test('GET /tasks (no filter) → all tasks', withTempHome(async () => {
  await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'a', payload: {} });
  await enqueueBackgroundTask({ type: 'auto.dreaming', idempotencyKey: 'b', payload: {} });
  const { ctx, res } = makeCtx('GET', '/tasks');
  await handleTasks()(ctx);
  assert.equal(res.statusCode, 200);
  const body = decode(res.body);
  assert.equal(body.count, 2);
  assert.equal(body.tasks.length, 2);
}));

test('GET /tasks?type=connector.init → filtered', withTempHome(async () => {
  await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'c1', payload: {} });
  await enqueueBackgroundTask({ type: 'connector.init', idempotencyKey: 'c2', payload: {} });
  await enqueueBackgroundTask({ type: 'auto.dreaming', idempotencyKey: 'd1', payload: {} });
  const { ctx, res } = makeCtx('GET', '/tasks', { type: 'connector.init' });
  await handleTasks()(ctx);
  const body = decode(res.body);
  assert.equal(body.count, 2);
  assert.ok(body.tasks.every((t: any) => t.type === 'connector.init'));
}));

test('GET /tasks?status=queued,running → multi-status filter', withTempHome(async () => {
  await enqueueBackgroundTask({ type: 't', idempotencyKey: 'x', payload: {} });
  const { ctx, res } = makeCtx('GET', '/tasks', { status: 'queued,running' });
  await handleTasks()(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(decode(res.body).count, 1);
}));

test('GET /tasks?status=bad → 400', withTempHome(async () => {
  const { ctx, res } = makeCtx('GET', '/tasks', { status: 'wat' });
  await handleTasks()(ctx);
  assert.equal(res.statusCode, 400);
  assert.match(decode(res.body).error, /Invalid status/);
}));

test('GET /tasks?limit=abc → 400', withTempHome(async () => {
  const { ctx, res } = makeCtx('GET', '/tasks', { limit: 'abc' });
  await handleTasks()(ctx);
  assert.equal(res.statusCode, 400);
  assert.match(decode(res.body).error, /Invalid limit/);
}));

test('GET /tasks?limit=1 → caps result count', withTempHome(async () => {
  await enqueueBackgroundTask({ type: 't', idempotencyKey: 'a', payload: {} });
  await enqueueBackgroundTask({ type: 't', idempotencyKey: 'b', payload: {} });
  const { ctx, res } = makeCtx('GET', '/tasks', { limit: '1' });
  await handleTasks()(ctx);
  assert.equal(decode(res.body).count, 1);
}));

// ──────────────────────────────────────────────────────────────────────
// Method + prefix gating
// ──────────────────────────────────────────────────────────────────────

test('POST /tasks/:id → not handled (returns false; falls through chain)', withTempHome(async () => {
  const { ctx } = makeCtx('POST', '/tasks/anything');
  const handled = await handleTasks()(ctx);
  assert.equal(handled, false);
}));

test('GET /unrelated → not handled (returns false)', withTempHome(async () => {
  const { ctx } = makeCtx('GET', '/composio/status');
  const handled = await handleTasks()(ctx);
  assert.equal(handled, false);
}));
