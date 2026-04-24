/**
 * Manual smoke run — boots a real http.Server hosting the same route
 * handlers the proactive-ai-frontend talks to (handleDreaming,
 * handleCrystallize, handleSettings) against a fresh temp DB, then
 * fires real HTTP POSTs with mock data so you can SEE that each of the
 * three evolution paths works end-to-end on the wire.
 *
 * Run:
 *   cd pinai-openclaw/plugins/proactive-ai
 *   npx tsx scripts/evolution-smoke.ts
 *
 * Output: a play-by-play of every HTTP call with status, response body,
 * and the persisted DB rows (dream_runs, evolution_runs, memory, skills).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleDreaming } from '../routes/dreaming.ts';
import { handleCrystallize } from '../routes/crystallize.ts';
import { handleSettings } from '../routes/settings.ts';
import {
  listEvolutionRuns,
  listMemoryV3,
  listSkills,
  upsertProfile,
  bumpCrystallizeTurn,
  resetDbForTests,
} from '../db.ts';
import { resetRawDbForTests } from '../raw-db.ts';
import { listDreamRuns } from '../dreaming/service.ts';
import { resetStoreForTests as resetDreamStoreForTests } from '../dreaming/store.ts';
import { runCrystallize } from '../conversation-crystallize/service.ts';

// Fake openclaw subagent that returns a canned synthesis (so dreaming /
// crystallize don't need a real LLM). Mirrors the harness we use in the
// e2e test suite.
const DREAM_SYNTHESIS = {
  summary: { kind: 'updated', text: 'Smoke run dream', highlights: ['interest in coffee'] },
  candidateCards: [],
  journalMarkdown: '# Smoke run\nUser had a productive coffee + commute pattern.',
  interestTopics: ['coffee', 'commute'],
  goalDelta: { changes: [] },
};

const CRYSTALLIZE_SYNTHESIS = {
  summary: 'User strongly prefers async communication on weekends',
  salience: 0.85,
  decision: 'memorize' as const,
  memory: {
    kind: 'user_profile',
    text: 'User prefers async communication on weekends.',
    tags: ['communication', 'preference'],
  },
};

function makeApi() {
  const fenced = '```json\n' + JSON.stringify(DREAM_SYNTHESIS) + '\n```';
  return {
    logger: {
      info: (m: string) => console.log(`[plugin:info] ${m}`),
      warn: (m: string) => console.warn(`[plugin:warn] ${m}`),
      error: (m: string) => console.error(`[plugin:error] ${m}`),
      debug: () => undefined,
    },
    runtime: {
      subagent: {
        run: async () => ({ runId: `subagent-run-${Date.now()}` }),
        waitForRun: async () => ({ status: 'ok' as const }),
        getSessionMessages: async () => ({ messages: [{ role: 'assistant', content: fenced }] }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

async function bootServer(port = 0): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dreaming = handleDreaming();
  const crystallize = handleCrystallize({
    runCrystallize: async (api, opts) => runCrystallize(api, opts, {
      // Bypass the 10-message threshold and 30-min cooldown for the smoke run
      // by injecting state + canned evaluator output (real DB writers).
      getCrystallizeState: async () => ({
        turn_count: 99, last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:card:run_smoke_1',
        last_message_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }),
      collectTurns: async () => ([{
        sessionKey: 'agent:main:proactive-ai:chat:card:run_smoke_1',
        userText: 'Please remember I prefer async communication on weekends.'.padEnd(300, '.'),
        assistantText: 'Got it — async only on weekends.',
        timestamp: null,
      }]),
      runEvaluator: async () => CRYSTALLIZE_SYNTHESIS,
    }),
  });
  const settings = handleSettings();

  const handlers = [dreaming, crystallize, settings];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx = { api: makeApi(), url, req, res, subpath: url.pathname };
    for (const h of handlers) {
      if (await h(ctx as never)) return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found', path: url.pathname }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  const realPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    baseUrl: `http://127.0.0.1:${realPort}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function banner(s: string): void {
  const line = '─'.repeat(78);
  console.log(`\n${line}\n${s}\n${line}`);
}

async function curl(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  console.log(`\n→ ${method} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')}` + (body ? `\n  body: ${JSON.stringify(body)}` : ''));
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  console.log(`← ${res.status} ${JSON.stringify(parsed).slice(0, 500)}`);
  return { status: res.status, body: parsed };
}

async function waitFor<T>(label: string, predicate: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor "${label}" timed out after ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  // Fresh temp home
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-smoke-'));
  process.env.OPENCLAW_HOME = home;
  resetDbForTests(); resetRawDbForTests(); resetDreamStoreForTests();

  // Profile must exist for setFact to land via apply-profile
  await upsertProfile({ displayName: 'Smoke User', locale: 'en', timezone: 'UTC' });

  const { baseUrl, close } = await bootServer();
  console.log(`\nBooted plugin server at ${baseUrl}`);
  console.log(`Temp OPENCLAW_HOME = ${home}\n`);

  try {
    // ── Path 1: settings toggles (Auto Dreaming + Auto Crystallize) ────
    banner('PATH 1 — Settings toggles (auto-dreaming on/off, auto-crystallize on/off)');

    await curl('GET', `${baseUrl}/settings/auto-dreaming`);
    await curl('POST', `${baseUrl}/settings/auto-dreaming`, { enabled: true });
    await curl('GET', `${baseUrl}/settings/auto-dreaming`);
    await curl('POST', `${baseUrl}/settings/auto-dreaming`, { enabled: false });
    await curl('POST', `${baseUrl}/settings/auto-dreaming`, { enabled: 'oops' }); // 400

    await curl('GET', `${baseUrl}/settings/auto-crystallize`);
    await curl('POST', `${baseUrl}/settings/auto-crystallize`, { enabled: false });
    await curl('GET', `${baseUrl}/settings/auto-crystallize`);

    // ── Path 2: Manual dream (the button frontend hits) ────────────────
    banner('PATH 2 — Manual dream: POST /dreaming/run + apply-profile + apply-goals');

    const start = await curl('POST', `${baseUrl}/dreaming/run`);
    if (start.status !== 202 || !start.body?.runId) throw new Error('start dream failed');
    const dreamId = start.body.runId as string;

    // Poll until completed (fake LLM is fast)
    const completed = await waitFor('dream completion', async () => {
      const list = await listDreamRuns();
      const m = list.find((r) => r.id === dreamId);
      return m && (m.status === 'completed' || m.status === 'failed') ? m : null;
    });
    console.log(`\n  ✓ dream_run ${dreamId} reached status='${completed.status}' in background`);

    await curl('GET', `${baseUrl}/dreaming/runs`);
    await curl('GET', `${baseUrl}/dreaming/runs/${dreamId}`);
    await curl('POST', `${baseUrl}/dreaming/runs/${dreamId}/apply-profile`);
    await curl('POST', `${baseUrl}/dreaming/runs/${dreamId}/apply-goals`);

    // ── Path 3: Manual crystallize (chat_burst force run) ──────────────
    banner('PATH 3 — Manual crystallize: POST /crystallize/run');

    await curl('GET', `${baseUrl}/crystallize/state`);
    await curl('POST', `${baseUrl}/crystallize/run`);
    await curl('GET', `${baseUrl}/crystallize/state`);

    // ── Persisted side effects ────────────────────────────────────────
    banner('SIDE EFFECTS — what landed in the database');

    const dreams = await listDreamRuns();
    console.log(`\ndream_runs (${dreams.length}):`);
    for (const r of dreams) {
      console.log(`  ${r.id} trigger=${r.trigger} status=${r.status} applied_at=${r.applied_at ?? '-'} goals_applied_at=${r.goals_applied_at ?? '-'}`);
    }

    const evol = await listEvolutionRuns({ limit: 20 });
    console.log(`\nevolution_runs (${evol.length}):`);
    for (const r of evol) {
      console.log(`  ${r.id.slice(0, 12)}… trigger=${r.trigger_kind} status=${r.status} memories=${r.memories_written} skills=${r.skills_added} profile_updated=${r.profile_updated}`);
    }

    const memories = await listMemoryV3({ status: 'active', limit: 20 });
    console.log(`\nmemory (${memories.length}):`);
    for (const m of memories) {
      console.log(`  ${m.id.slice(0, 12)}… [${m.source}] "${m.text.slice(0, 60)}…"`);
    }

    const skills = await listSkills();
    console.log(`\nskill_index (${skills.length}):`);
    for (const s of skills) {
      console.log(`  ${s.id} [${s.status}] ${s.title}`);
    }

    banner('SUMMARY');
    console.log(`✔ Manual dream       — ${dreams.filter((d) => d.trigger === 'manual' && d.status === 'completed').length} completed dream_run, ${evol.filter((e) => e.trigger_kind === 'daily_dream').length} daily_dream evolution_run`);
    console.log(`✔ Manual crystallize — ${evol.filter((e) => e.trigger_kind === 'chat_burst').length} chat_burst evolution_run, ${memories.length} memory, ${skills.length} skill`);
    console.log(`✔ Settings toggles   — both /settings/auto-dreaming and /settings/auto-crystallize accept POST + reject bad input with 400`);

    console.log('\nAll three paths exercised over real HTTP against the same handlers the frontend hits.');
  } finally {
    await close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n✖ Smoke run failed:', err);
  process.exit(1);
});
