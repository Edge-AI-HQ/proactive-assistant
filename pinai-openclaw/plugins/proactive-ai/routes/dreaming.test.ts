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

// ── 4. Phase 2a: dreams write through, no separate apply step ──────────

test('write-through: completing the run materializes interests + facts immediately',
  withTempHome(async (api) => {
    // Profile must exist for setFact updates to land.
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    // Drive a real dream end-to-end. With Phase 2a there's no follow-up
    // /apply-profile call — the dream's own commit applies the delta.
    const handler = handleDreaming();
    const start = makeCtx(api, 'POST', '/dreaming/run');
    await handler(start.ctx);
    const startBody = JSON.parse(start.res.body);
    assert.equal(await waitForDreamFinal(startBody.runId), 'completed');

    // Side effects already happened — no Apply Profile button needed.
    const profile = await getProfile();
    assert.ok((profile!.facts as Record<string, unknown>).dreaming);
    const interests = await listInterests({ limit: 50 });
    assert.deepEqual(interests.map((i) => i.key).sort(), ['coffee', 'commute']);

    // The run's applied_at + goals_applied_at are stamped during the run.
    const detail = makeCtx(api, 'GET', `/dreaming/runs/${startBody.runId}`);
    await handler(detail.ctx);
    const detailBody = JSON.parse(detail.res.body);
    assert.ok(detailBody.run.applied_at, 'applied_at must be stamped during the run');
    assert.ok(detailBody.run.goals_applied_at, 'goals_applied_at must be stamped during the run');
  }));

// ── 5. Legacy /apply-profile + /apply-goals routes return 410 Gone ─────

test('POST /dreaming/runs/:id/apply-profile → 410 Gone (Phase 2a removed)',
  withTempHome(async () => {
    const handler = handleDreaming();
    const apply = makeCtx(makeDreamingApi(), 'POST', '/dreaming/runs/dream_anything/apply-profile');
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 410);
    const body = JSON.parse(apply.res.body);
    assert.equal(body.ok, false);
    assert.match(body.hint, /apply directly during the run/);
  }));

test('POST /dreaming/runs/:id/apply-goals → 410 Gone (Phase 2a removed)',
  withTempHome(async () => {
    const handler = handleDreaming();
    const apply = makeCtx(makeDreamingApi(), 'POST', '/dreaming/runs/dream_anything/apply-goals');
    await handler(apply.ctx);
    assert.equal(apply.res.statusCode, 410);
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
    // Backdate it manually. Phase 2d: dream_runs is gone — the row lives
    // in evolution_runs now under the same id.
    const sevenMinAgo = new Date(Date.now() - 7 * 60_000).toISOString();
    const { default: Database } = await import('better-sqlite3');
    const dbPath = `${process.env.OPENCLAW_HOME}/data/proactive.db`;
    const conn = new Database(dbPath);
    conn.prepare(`UPDATE evolution_runs SET started_at = ? WHERE id = ?`).run(sevenMinAgo, old.id);
    conn.close();

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
    // Backdate. Phase 2d: row lives in evolution_runs now.
    const { default: Database } = await import('better-sqlite3');
    const conn = new Database(`${process.env.OPENCLAW_HOME}/data/proactive.db`);
    conn.prepare(`UPDATE evolution_runs SET started_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), r.id);
    conn.close();

    const swept = await sweepStaleRunningDreams();
    assert.equal(swept, 0);
    const after = await store.getRun(r.id);
    assert.equal(after!.status, 'completed', 'completed runs are not touched');
  }));
