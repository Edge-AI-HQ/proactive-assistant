/**
 * Integration tests for the v3 routes:
 *   /memory      (handleMemory)
 *   /signals     (handleSignals)
 *   /raw/...     (handleRaw)
 *   /evolution   (handleEvolution)
 *
 * Uses a mock req/res pair (same pattern as routes/mobile.test.ts).
 * See docs/plans/memory-architecture.mdx §六.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleMemory } from './memory.ts';
import { handleSignals } from './signals.ts';
import { handleRaw } from './raw.ts';
import { handleEvolution } from './evolution.ts';
import { resetDbForTests } from '../db.ts';
import { ingestGmailMessages, resetRawDbForTests } from '../raw-db.ts';

function withTempHome(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-routes-'));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    resetRawDbForTests();
    try {
      await fn();
    } finally {
      resetDbForTests();
      resetRawDbForTests();
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function createRequest(method: string, body?: Record<string, unknown>) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  if (body !== undefined) req.end(JSON.stringify(body));
  else req.end();
  return req;
}

function createResponse() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      r.statusCode = status; r.headers = headers; return r;
    },
    end(chunk?: string) {
      if (chunk) r.body += chunk; return r;
    },
  };
  return r;
}

async function call(handler: ReturnType<typeof handleMemory>, opts: {
  method: string;
  subpath: string;
  body?: Record<string, unknown>;
  query?: string;
}) {
  const res = createResponse();
  const url = new URL(`http://localhost${opts.subpath}${opts.query ? `?${opts.query}` : ''}`);
  const handled = await handler({
    api: {} as never,
    url,
    req: createRequest(opts.method, opts.body),
    res,
    subpath: opts.subpath,
  } as never);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

// ─── /memory ────────────────────────────────────────────────────────────

test('POST /memory: rejects when text or source missing', withTempHome(async () => {
  const h = handleMemory();
  const r1 = await call(h, { method: 'POST', subpath: '/memory', body: {} });
  assert.equal(r1.status, 400);
  const r2 = await call(h, { method: 'POST', subpath: '/memory', body: { text: 'hi' } });
  assert.equal(r2.status, 400);
}));

test('POST /memory then GET /memory round-trips', withTempHome(async () => {
  const h = handleMemory();
  const post = await call(h, {
    method: 'POST', subpath: '/memory',
    body: { text: '用户喜欢手冲咖啡', source: 'manual', subject: 'topic:coffee', quality: 0.8 },
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.memory.text, '用户喜欢手冲咖啡');
  const id = post.body.memory.id;

  const list = await call(h, { method: 'GET', subpath: '/memory' });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.memories.length, 1);
  assert.equal(list.body.memories[0].id, id);

  const get = await call(h, { method: 'GET', subpath: `/memory/${id}` });
  assert.equal(get.status, 200);
  assert.equal(get.body.memory.id, id);
}));

test('GET /memory respects minQuality query param', withTempHome(async () => {
  const h = handleMemory();
  await call(h, { method: 'POST', subpath: '/memory', body: { text: 'low', source: 'manual', quality: 0.3 } });
  await call(h, { method: 'POST', subpath: '/memory', body: { text: 'high', source: 'manual', quality: 0.9 } });
  const list = await call(h, { method: 'GET', subpath: '/memory', query: 'minQuality=0.5' });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.memories.length, 1);
  assert.equal(list.body.memories[0].text, 'high');
}));

test('GET /memory keeps total while paging with offset', withTempHome(async () => {
  const h = handleMemory();
  for (let i = 0; i < 5; i += 1) {
    await call(h, { method: 'POST', subpath: '/memory', body: { text: `memory ${i}`, source: 'manual' } });
  }
  const first = await call(h, { method: 'GET', subpath: '/memory', query: 'limit=2&offset=0' });
  const second = await call(h, { method: 'GET', subpath: '/memory', query: 'limit=2&offset=2' });
  assert.equal(first.body.total, 5);
  assert.equal(second.body.total, 5);
  assert.equal(first.body.memories.length, 2);
  assert.equal(second.body.memories.length, 2);
  assert.equal(new Set([...first.body.memories, ...second.body.memories].map((row: { id: string }) => row.id)).size, 4);
}));

test('POST /memory/<id>/archive moves status to archived', withTempHome(async () => {
  const h = handleMemory();
  const post = await call(h, { method: 'POST', subpath: '/memory', body: { text: 'x', source: 'manual' } });
  const id = post.body.memory.id;
  const arch = await call(h, { method: 'POST', subpath: `/memory/${id}/archive` });
  assert.equal(arch.status, 200);
  const active = await call(h, { method: 'GET', subpath: '/memory' });
  assert.equal(active.body.total, 0);
  assert.equal(active.body.memories.length, 0);
  const archived = await call(h, { method: 'GET', subpath: '/memory', query: 'status=archived' });
  assert.equal(archived.body.total, 1);
  assert.equal(archived.body.memories.length, 1);
}));

test('PATCH /memory/<id> updates text / quality / tags in place', withTempHome(async () => {
  const h = handleMemory();
  const post = await call(h, {
    method: 'POST', subpath: '/memory',
    body: { text: 'v1', source: 'manual', quality: 0.3, tags: ['a'] },
  });
  const id = post.body.memory.id;
  const patched = await call(h, {
    method: 'PATCH', subpath: `/memory/${id}`,
    body: { text: 'v2', quality: 0.8, tags: ['a', 'b'] },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.memory.text, 'v2');
  assert.equal(patched.body.memory.quality, 0.8);
  assert.deepEqual(patched.body.memory.tags, ['a', 'b']);
}));

test('PATCH /memory/<id> returns 404 for unknown id', withTempHome(async () => {
  const h = handleMemory();
  const r = await call(h, { method: 'PATCH', subpath: '/memory/nope', body: { text: 'x' } });
  assert.equal(r.status, 404);
}));

test('PATCH /memory/<id> rejects empty patch', withTempHome(async () => {
  const h = handleMemory();
  const post = await call(h, { method: 'POST', subpath: '/memory', body: { text: 'hi', source: 'manual' } });
  const r = await call(h, { method: 'PATCH', subpath: `/memory/${post.body.memory.id}`, body: {} });
  assert.equal(r.status, 400);
}));

test('POST /memory/supersede links rows', withTempHome(async () => {
  const h = handleMemory();
  const a = await call(h, { method: 'POST', subpath: '/memory', body: { text: 'old', source: 'manual' } });
  const b = await call(h, { method: 'POST', subpath: '/memory', body: { text: 'new', source: 'manual' } });
  const sup = await call(h, {
    method: 'POST', subpath: '/memory/supersede',
    body: { oldId: a.body.memory.id, newId: b.body.memory.id },
  });
  assert.equal(sup.status, 200);
  const aRow = await call(h, { method: 'GET', subpath: `/memory/${a.body.memory.id}` });
  assert.equal(aRow.body.memory.status, 'superseded');
  assert.equal(aRow.body.memory.superseded_by, b.body.memory.id);
}));

// ─── /signals ───────────────────────────────────────────────────────────

test('POST /signals/ingest then GET /signals returns the row', withTempHome(async () => {
  const h = handleSignals();
  const ing = await call(h, {
    method: 'POST', subpath: '/signals/ingest',
    body: {
      items: [{
        kind: 'attention_item', title: 'Mom', summary: 'msg', salience: 0.8,
        deviceId: 'dev-1',
      }],
    },
  });
  assert.equal(ing.status, 200);
  assert.equal(ing.body.inserted, 1);
  const list = await call(h, { method: 'GET', subpath: '/signals' });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.signals.length, 1);
  assert.equal(list.body.signals[0].title, 'Mom');
}));

test('POST /signals/<id>/consume requires runId', withTempHome(async () => {
  const h = handleSignals();
  const ing = await call(h, {
    method: 'POST', subpath: '/signals/ingest',
    body: { items: [{ kind: 'm', title: 't', summary: 's' }] },
  });
  const id = ing.body.ids[0];
  const noRun = await call(h, { method: 'POST', subpath: `/signals/${id}/consume`, body: {} });
  assert.equal(noRun.status, 400);
  const ok = await call(h, { method: 'POST', subpath: `/signals/${id}/consume`, body: { runId: 'run-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.updated, 1);
}));

test('GET /signals filters by minSalience', withTempHome(async () => {
  const h = handleSignals();
  await call(h, {
    method: 'POST', subpath: '/signals/ingest',
    body: {
      items: [
        { kind: 'm', title: 'low', summary: 'l', salience: 0.2 },
        { kind: 'm', title: 'high', summary: 'h', salience: 0.8 },
      ],
    },
  });
  const r = await call(h, { method: 'GET', subpath: '/signals', query: 'minSalience=0.5' });
  assert.equal(r.body.total, 1);
  assert.equal(r.body.signals.length, 1);
  assert.equal(r.body.signals[0].title, 'high');
}));

test('GET /signals keeps total while paging with offset', withTempHome(async () => {
  const h = handleSignals();
  await call(h, {
    method: 'POST', subpath: '/signals/ingest',
    body: {
      items: Array.from({ length: 5 }, (_, i) => ({
        kind: 'm',
        title: `signal ${i}`,
        summary: `summary ${i}`,
        salience: 0.8,
      })),
    },
  });
  const first = await call(h, { method: 'GET', subpath: '/signals', query: 'limit=2&offset=0' });
  const second = await call(h, { method: 'GET', subpath: '/signals', query: 'limit=2&offset=2' });
  assert.equal(first.body.total, 5);
  assert.equal(second.body.total, 5);
  assert.equal(first.body.signals.length, 2);
  assert.equal(second.body.signals.length, 2);
  assert.equal(new Set([...first.body.signals, ...second.body.signals].map((row: { id: string }) => row.id)).size, 4);
}));

test('GET /signals paginates by `before` cursor (keyset)', withTempHome(async () => {
  const h = handleSignals();
  // 5 items with strictly decreasing occurred_at (newest first when listed).
  await call(h, {
    method: 'POST', subpath: '/signals/ingest',
    body: {
      items: Array.from({ length: 5 }, (_, i) => ({
        kind: 'm',
        title: `cursor ${i}`,
        summary: `summary ${i}`,
        salience: 0.5,
        occurredAt: new Date(Date.UTC(2026, 3, 28, 12, 0, i)).toISOString(),
      })),
    },
  });

  const p1 = await call(h, { method: 'GET', subpath: '/signals', query: 'limit=2' });
  assert.equal(p1.body.signals.length, 2);
  assert.equal(p1.body.has_more, true);
  assert.ok(p1.body.next_cursor, `expected next_cursor, got: ${p1.body.next_cursor}`);

  const p2 = await call(h, {
    method: 'GET',
    subpath: '/signals',
    query: `limit=2&before=${encodeURIComponent(p1.body.next_cursor as string)}`,
  });
  assert.equal(p2.body.signals.length, 2);
  assert.equal(p2.body.has_more, true);

  const p3 = await call(h, {
    method: 'GET',
    subpath: '/signals',
    query: `limit=2&before=${encodeURIComponent(p2.body.next_cursor as string)}`,
  });
  assert.equal(p3.body.signals.length, 1);
  assert.equal(p3.body.has_more, false);
  assert.equal(p3.body.next_cursor, null);

  // No duplicates across pages.
  const ids = [...p1.body.signals, ...p2.body.signals, ...p3.body.signals]
    .map((r: { id: string }) => r.id);
  assert.equal(new Set(ids).size, 5);

  // total is suppressed (-1) when paginating by cursor.
  assert.equal(p2.body.total, -1);
}));

// ─── /raw ───────────────────────────────────────────────────────────────

test('GET /raw/gmail returns ingested rows', withTempHome(async () => {
  ingestGmailMessages([
    { messageId: 'm1', subject: 'Welcome', occurredAt: '2026-04-23T10:00:00Z' },
    { messageId: 'm2', subject: 'Update', occurredAt: '2026-04-22T10:00:00Z' },
  ]);
  const h = handleRaw();
  const r = await call(h, { method: 'GET', subpath: '/raw/gmail' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.messages.length, 2);
  // Newest first
  assert.equal(r.body.messages[0].subject, 'Welcome');
}));

test('GET /raw/device-apps with latestSnapshotOnly=1 reads latest snapshot', withTempHome(async () => {
  // For brevity, ingest via raw-db directly
  const { ingestDeviceAppsSnapshot } = await import('../raw-db.ts');
  ingestDeviceAppsSnapshot({
    deviceId: 'dev-1',
    capturedAt: '2026-04-22T08:00:00Z',
    apps: [{ bundleId: 'com.old', appName: 'Old' }],
  });
  ingestDeviceAppsSnapshot({
    deviceId: 'dev-1',
    capturedAt: '2026-04-23T08:00:00Z',
    apps: [{ bundleId: 'com.new', appName: 'New' }],
  });
  const h = handleRaw();
  const r = await call(h, { method: 'GET', subpath: '/raw/device-apps', query: 'deviceId=dev-1&latestSnapshotOnly=1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.apps.length, 1);
  assert.equal(r.body.apps[0].app_name, 'New');
}));

test('GET /raw/device-contacts with latestSnapshotOnly=1 reads latest snapshot', withTempHome(async () => {
  const { ingestDeviceContactsSnapshot } = await import('../raw-db.ts');
  ingestDeviceContactsSnapshot({
    deviceId: 'dev-1',
    capturedAt: '2026-04-22T08:00:00Z',
    contacts: [{ displayName: 'Old Person', emails: ['old@example.com'] }],
  });
  ingestDeviceContactsSnapshot({
    deviceId: 'dev-1',
    capturedAt: '2026-04-23T08:00:00Z',
    contacts: [{ displayName: 'New Person', emails: ['new@example.com'] }],
  });
  const h = handleRaw();
  const r = await call(h, { method: 'GET', subpath: '/raw/device-contacts', query: 'deviceId=dev-1&latestSnapshotOnly=1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.contacts.length, 1);
  assert.equal(r.body.contacts[0].display_name, 'New Person');
}));

// ─── /evolution ─────────────────────────────────────────────────────────

test('POST /evolution then GET /evolution/<id> round-trips', withTempHome(async () => {
  const h = handleEvolution();
  const create = await call(h, {
    method: 'POST', subpath: '/evolution',
    body: { triggerKind: 'daily_dream', windowStart: '2026-04-23T00:00:00Z' },
  });
  assert.equal(create.status, 200);
  assert.equal(create.body.run.trigger_kind, 'daily_dream');
  const id = create.body.run.id;

  const delta = await call(h, {
    method: 'POST', subpath: `/evolution/${id}/delta`,
    body: { memoriesWritten: 5, profileUpdated: true, profileChangedKeys: ['summary'] },
  });
  assert.equal(delta.status, 200);

  const refsCons = await call(h, {
    method: 'POST', subpath: `/evolution/${id}/refs/consumed`,
    body: { table: 'personal_signals', ids: ['s1', 's2'] },
  });
  assert.equal(refsCons.status, 200);

  const refsProd = await call(h, {
    method: 'POST', subpath: `/evolution/${id}/refs/produced`,
    body: { table: 'memory', ids: ['m1', 'm2', 'm3'] },
  });
  assert.equal(refsProd.status, 200);

  const complete = await call(h, {
    method: 'POST', subpath: `/evolution/${id}/complete`,
    body: { llmTokens: 4321, durationMs: 8000 },
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.run.status, 'completed');
  assert.equal(complete.body.run.memories_written, 5);
  assert.deepEqual(complete.body.run.refs_consumed, { personal_signals: ['s1', 's2'] });
  assert.deepEqual(complete.body.run.refs_produced, { memory: ['m1', 'm2', 'm3'] });
  assert.equal(complete.body.run.llm_tokens, 4321);
}));

test('POST /evolution requires triggerKind', withTempHome(async () => {
  const h = handleEvolution();
  const r = await call(h, { method: 'POST', subpath: '/evolution', body: {} });
  assert.equal(r.status, 400);
}));

test('POST /evolution/<id>/fail records error_message', withTempHome(async () => {
  const h = handleEvolution();
  const created = await call(h, {
    method: 'POST', subpath: '/evolution', body: { triggerKind: 'manual' },
  });
  const id = created.body.run.id;
  const failed = await call(h, {
    method: 'POST', subpath: `/evolution/${id}/fail`, body: { error: 'LLM timeout' },
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.run.status, 'failed');
  assert.equal(failed.body.run.error_message, 'LLM timeout');
}));

test('GET /evolution filters by triggerKind and status', withTempHome(async () => {
  const h = handleEvolution();
  const a = await call(h, { method: 'POST', subpath: '/evolution', body: { triggerKind: 'daily_dream' } });
  await call(h, { method: 'POST', subpath: '/evolution', body: { triggerKind: 'chat_burst' } });
  await call(h, { method: 'POST', subpath: `/evolution/${a.body.run.id}/complete`, body: {} });

  const dreams = await call(h, { method: 'GET', subpath: '/evolution', query: 'triggerKind=daily_dream' });
  assert.equal(dreams.body.runs.length, 1);

  const completed = await call(h, { method: 'GET', subpath: '/evolution', query: 'status=completed' });
  assert.equal(completed.body.runs.length, 1);
}));
