/**
 * Route-level coverage for /dreaming/* — the handlers behind the manual
 * dream button + apply-profile/apply-goals controls in
 * proactive-ai-frontend/src/components/AutoDreamingSettings.tsx.
 *
 * Goes the full chain: HTTP request → route handler → real DB writes
 * (dream_runs + evolution_runs + profile_*). The LLM call is stubbed via
 * a fake api.runtime.subagent that returns a canned synthesis JSON, same
 * pattern as evolution-three-triggers.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleDreaming } from './dreaming.ts';
import * as store from '../dreaming/store.ts';
import { resetStoreForTests as resetDreamStoreForTests, sweepStaleRunningDreams } from '../dreaming/store.ts';
import {
  getProfile,
  upsertProfile,
  listInterests,
  listEvolutionRuns,
  resetDbForTests,
} from '../db.ts';
import { resetRawDbForTests } from '../raw-db.ts';

// ── Test harness ─────────────────────────────────────────────────────────

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
    writeHead(s: number, h: Record<string, string>) {
      r.statusCode = s; r.headers = h; return r;
    },
    end(c?: string) { if (c) r.body += c; return r; },
  };
  return r;
}

function makeCtx(api: unknown, method: string, subpath: string, body?: Record<string, unknown>) {
  const res = createResponse();
  return {
    ctx: {
      subpath,
      req: createRequest(method, body),
      res,
      url: new URL(`http://localhost${subpath}`),
      api,
    } as never,
    res,
  };
}

const SYNTHESIS_FIXTURE = {
  summary: { kind: 'updated', text: 'A quiet day with a couple of patterns.', highlights: ['morning coffee'] },
  candidateCards: [],
  journalMarkdown: '# Dream\nUser kept their morning coffee habit.',
  interestTopics: ['coffee', 'commute'],
  goalDelta: { changes: [] },
};

function makeDreamingApi(synthesis: Record<string, unknown> = SYNTHESIS_FIXTURE) {
  const fenced = '```json\n' + JSON.stringify(synthesis) + '\n```';
  return {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
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

function withTempHome(fn: (api: ReturnType<typeof makeDreamingApi>) => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-dreaming-route-'));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    resetRawDbForTests();
    resetDreamStoreForTests();
    try {
      await fn(makeDreamingApi());
    } finally {
      resetDbForTests();
      resetRawDbForTests();
      resetDreamStoreForTests();
      if (previous === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

async function waitForDreamFinal(runId: string, timeoutMs = 5000): Promise<'completed' | 'failed' | 'running'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await store.getRun(runId);
    if (r && (r.status === 'completed' || r.status === 'failed')) return r.status;
    await new Promise((res) => setTimeout(res, 25));
  }
  const r = await store.getRun(runId);
  return r?.status ?? 'running';
}

// ── 1. POST /dreaming/run ────────────────────────────────────────────────

test('POST /dreaming/run returns 202 + runId, then completes in background',
  withTempHome(async (api) => {
    const handler = handleDreaming();
    const { ctx, res } = makeCtx(api, 'POST', '/dreaming/run');
    const handled = await handler(ctx);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 202);

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.runId);
    assert.equal(body.status, 'running');

    const final = await waitForDreamFinal(body.runId);
    assert.equal(final, 'completed', 'dream must complete with stubbed subagent');

    // The run is also reflected in evolution_runs as trigger_kind='daily_dream'.
    const evol = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 5 });
    assert.equal(evol.length, 1);
    assert.equal(evol[0]!.status, 'completed');
    // Manual triggers stamp 'trigger=manual' in the context_summary.
    assert.match(evol[0]!.context_summary ?? '', /trigger=manual/);
  }));

// ── 2. GET /dreaming/runs ────────────────────────────────────────────────

test('GET /dreaming/runs returns the list (newest first)', withTempHome(async () => {
  await store.createRun({
    trigger: 'auto', windowStart: '2026-04-23T00:00:00Z', windowEnd: '2026-04-24T00:00:00Z',
  });
  await store.createRun({
    trigger: 'manual', windowStart: '2026-04-22T00:00:00Z', windowEnd: '2026-04-23T00:00:00Z',
  });

  const handler = handleDreaming();
  const { ctx, res } = makeCtx(makeDreamingApi(), 'GET', '/dreaming/runs');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.runs.length, 2);
}));

// ── 3. GET /dreaming/runs/:id ────────────────────────────────────────────

test('GET /dreaming/runs/:id returns detail; 404 for unknown', withTempHome(async () => {
  const r = await store.createRun({
    trigger: 'manual', windowStart: '2026-04-23T00:00:00Z', windowEnd: '2026-04-24T00:00:00Z',
  });
  const handler = handleDreaming();

  const ok = makeCtx(makeDreamingApi(), 'GET', `/dreaming/runs/${r.id}`);
  await handler(ok.ctx);
  assert.equal(ok.res.statusCode, 200);
  const okBody = JSON.parse(ok.res.body);
  assert.equal(okBody.ok, true);
  assert.equal(okBody.run.id, r.id);
  assert.ok(okBody.detail, 'detail should be present');

  const miss = makeCtx(makeDreamingApi(), 'GET', '/dreaming/runs/dream_does_not_exist');
  await handler(miss.ctx);
  assert.equal(miss.res.statusCode, 404);
}));

// ── 4. POST /dreaming/runs/:id/apply-profile ─────────────────────────────

test('POST /dreaming/runs/:id/apply-profile materializes interests + facts',
  withTempHome(async (api) => {
    // Profile must exist for setFact updates to land.
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    // Drive a real dream end-to-end so the run is 'completed' with a real delta.
    const handler = handleDreaming();
    const start = makeCtx(api, 'POST', '/dreaming/run');
    await handler(start.ctx);
    const startBody = JSON.parse(start.res.body);
    assert.equal(await waitForDreamFinal(startBody.runId), 'completed');

    const apply = makeCtx(api, 'POST', `/dreaming/runs/${startBody.runId}/apply-profile`);
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 200);
    const applyBody = JSON.parse(apply.res.body);
    assert.equal(applyBody.ok, true);
    assert.ok(applyBody.run.applied_at, 'applied_at should be stamped');

    // Side effects: profile.facts.dreaming has a key, profile_interests has rows.
    const profile = await getProfile();
    assert.ok((profile!.facts as Record<string, unknown>).dreaming);
    const interests = await listInterests({ limit: 50 });
    assert.deepEqual(interests.map((i) => i.key).sort(), ['coffee', 'commute']);
  }));

test('POST /dreaming/runs/:id/apply-profile returns 409 when run is still running',
  withTempHome(async () => {
    const r = await store.createRun({
      trigger: 'manual', windowStart: '2026-04-23T00:00:00Z', windowEnd: '2026-04-24T00:00:00Z',
    });
    // Don't complete it — leave status='running'.
    const handler = handleDreaming();
    const apply = makeCtx(makeDreamingApi(), 'POST', `/dreaming/runs/${r.id}/apply-profile`);
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 409, 'expected 409 Conflict for unfinished run');
    const body = JSON.parse(apply.res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /not completed/);
  }));

test('POST /dreaming/runs/:id/apply-profile returns 409 for unknown run',
  withTempHome(async () => {
    const handler = handleDreaming();
    const apply = makeCtx(makeDreamingApi(), 'POST', '/dreaming/runs/dream_no_such/apply-profile');
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 409);
    assert.match(JSON.parse(apply.res.body).error, /not found/);
  }));

// ── 5. POST /dreaming/runs/:id/apply-goals ───────────────────────────────

test('POST /dreaming/runs/:id/apply-goals stamps goals_applied_at on completed run',
  withTempHome(async (api) => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });
    const handler = handleDreaming();
    const start = makeCtx(api, 'POST', '/dreaming/run');
    await handler(start.ctx);
    const startBody = JSON.parse(start.res.body);
    assert.equal(await waitForDreamFinal(startBody.runId), 'completed');

    const apply = makeCtx(api, 'POST', `/dreaming/runs/${startBody.runId}/apply-goals`);
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 200);
    const body = JSON.parse(apply.res.body);
    assert.equal(body.ok, true);
    assert.ok(body.run.goals_applied_at, 'goals_applied_at should be stamped');
  }));

test('POST /dreaming/runs/:id/apply-goals → 409 for unknown run', withTempHome(async () => {
  const handler = handleDreaming();
  const apply = makeCtx(makeDreamingApi(), 'POST', '/dreaming/runs/dream_no_such/apply-goals');
  await handler(apply.ctx);
  assert.equal(apply.res.statusCode, 409);
}));

// ── 6. Unrelated subpaths fall through ──────────────────────────────────

test('handleDreaming returns false for unrelated paths', withTempHome(async () => {
  const handler = handleDreaming();
  const { ctx } = makeCtx(makeDreamingApi(), 'GET', '/something/else');
  const handled = await handler(ctx);
  assert.equal(handled, false);
}));

// ── 7. sweepStaleRunningDreams: cleans up pre-fix orphan rows ───────────

test('sweepStaleRunningDreams: marks running rows older than threshold as failed',
  withTempHome(async () => {
    // Old running row (predates the threshold)
    const old = await store.createRun({
      trigger: 'manual',
      windowStart: '2026-04-01T00:00:00Z',
      windowEnd: '2026-04-01T00:00:00Z',
    });
    // Backdate it manually so it looks > 5 min old
    const sevenMinAgo = new Date(Date.now() - 7 * 60_000).toISOString();
    // Use the same handle that store uses
    const { default: Database } = await import('better-sqlite3');
    const dbPath = `${process.env.OPENCLAW_HOME}/data/proactive.db`;
    const conn = new Database(dbPath);
    conn.prepare(`UPDATE dream_runs SET started_at = ? WHERE id = ?`).run(sevenMinAgo, old.id);
    conn.close();
    resetDreamStoreForTests();

    // Fresh running row (within threshold)
    const fresh = await store.createRun({
      trigger: 'manual',
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
    });

    const swept = await sweepStaleRunningDreams();
    assert.equal(swept, 1, 'only the > 5min row should flip');

    const oldAfter = await store.getRun(old.id);
    const freshAfter = await store.getRun(fresh.id);
    assert.equal(oldAfter!.status, 'failed');
    assert.match(oldAfter!.error_message ?? '', /sweepStaleRunningDreams/);
    assert.equal(freshAfter!.status, 'running');
  }));

test('sweepStaleRunningDreams: leaves completed/failed rows untouched',
  withTempHome(async () => {
    const r = await store.createRun({
      trigger: 'manual',
      windowStart: '2026-04-01T00:00:00Z',
      windowEnd: '2026-04-01T00:00:00Z',
    });
    // Complete it
    await store.completeRun(r.id, {
      sourceStats: {}, summary: { kind: 'no_new_data', text: '', sourceCount: 0, candidateCount: 0 },
      profileDelta: { facts: { before: {}, after: {} }, preferences: { before: {}, after: {} },
                      interests: { before: [], after: [] }, snapshots: { before: [], after: [] }},
      goalDelta: { changes: [] },
      journalMarkdown: 'done', candidates: [],
    });
    // Backdate
    const { default: Database } = await import('better-sqlite3');
    const conn = new Database(`${process.env.OPENCLAW_HOME}/data/proactive.db`);
    conn.prepare(`UPDATE dream_runs SET started_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), r.id);
    conn.close();
    resetDreamStoreForTests();

    const swept = await sweepStaleRunningDreams();
    assert.equal(swept, 0);
    const after = await store.getRun(r.id);
    assert.equal(after!.status, 'completed', 'completed runs are not touched');
  }));
