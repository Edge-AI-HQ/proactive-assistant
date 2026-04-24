/**
 * End-to-end coverage for the three evolution triggers.
 *
 *   1. chat_burst        — runCrystallize() (auto-loop or "force" from debug
 *                          panel). Writes memory + optional skill directly,
 *                          opens evolution_run with trigger_kind='chat_burst'.
 *   2. daily_dream / manual dream — runDreaming(trigger='auto'|'manual').
 *                          Writes profile facts/preferences/interests +
 *                          goals INLINE during the run (Phase 2a write-
 *                          through — no separate Apply step). Mirrors the
 *                          run into evolution_runs with trigger_kind='daily_dream',
 *                          stamping refs_produced for each affected key.
 *   3. manual via pin CLI — `pin evolution create --triggerKind manual`
 *                          followed by delta/refs/complete is a pure
 *                          bookkeeping ledger; useful when an external system
 *                          wants to record an evolution-equivalent change.
 *
 * Real DB writes (proactive.db, raw.db, dream_runs). Subagent calls (LLM)
 * are stubbed via `RunCrystallizeDeps.runEvaluator` for crystallize and via a
 * fake `api.runtime.subagent` for dreaming.
 *
 * See docs/plans/memory-architecture.mdx §三 (evolution_runs) and §八 Phase 2a.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCrystallize } from './conversation-crystallize/service.ts';
import { DEFAULT_CRYSTALLIZE_CONFIG } from './conversation-crystallize/types.ts';
import { runDreaming } from './dreaming/service.ts';
import { resetStoreForTests as resetDreamStoreForTests } from './dreaming/store.ts';
import { handleEvolution } from './cli/evolution.ts';
import {
  getProfile,
  upsertProfile,
  listInterests,
  getEvolutionRun,
  listEvolutionRuns,
  listMemoryV3,
  listSkills,
  resetDbForTests,
} from './db.ts';
import { resetRawDbForTests } from './raw-db.ts';

// ── Test harness ──────────────────────────────────────────────────────────

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-evol-3way-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  resetDreamStoreForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    resetDreamStoreForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function makeLogger() {
  const calls: Array<{ level: string; message: string }> = [];
  return {
    calls,
    info: (m: string) => calls.push({ level: 'info', message: m }),
    warn: (m: string) => calls.push({ level: 'warn', message: m }),
    error: (m: string) => calls.push({ level: 'error', message: m }),
    debug: (m: string) => calls.push({ level: 'debug', message: m }),
  };
}

/**
 * Minimal fake api for crystallize. The test injects `runEvaluator` so
 * the api's subagent surface is never used; we only need a logger.
 */
function makeCrystallizeApi() {
  return {
    logger: makeLogger(),
    runtime: {
      subagent: {
        run: async () => ({ runId: 'unused' }),
        waitForRun: async () => ({ status: 'ok' as const }),
        getSessionMessages: async () => ({ messages: [] }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

/**
 * Fake api for dreaming. runAgent inside dreaming/service.ts calls
 * api.runtime.subagent.run / waitForRun / getSessionMessages — we return a
 * canned assistant message containing the synthesis JSON so dream completes.
 */
function makeDreamingApi(synthesis: Record<string, unknown>) {
  const fenced = '```json\n' + JSON.stringify(synthesis) + '\n```';
  let lastSessionKey = '';
  return {
    logger: makeLogger(),
    runtime: {
      subagent: {
        run: async (args: { sessionKey: string }) => {
          lastSessionKey = args.sessionKey;
          return { runId: `run-${Date.now()}` };
        },
        waitForRun: async () => ({ status: 'ok' as const }),
        getSessionMessages: async () => ({
          messages: [{ role: 'assistant', content: fenced, sessionKey: lastSessionKey }],
        }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

function decode(json: string): { ok: boolean; data?: any; error?: any } {
  return JSON.parse(json);
}

// ── 1. chat_burst (card-driven) ───────────────────────────────────────────

test('chat_burst: memorize decision writes memory + opens chat_burst evolution_run', async () => {
  await withTempHome(async () => {
    const result = await runCrystallize(
      makeCrystallizeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        // Real db.addMemory / db.addUserSkill (the defaults). No mocks on writers.
        collectTurns: async () => ([{
          sessionKey: 'agent:main:proactive-ai:chat:card:run_card_1',
          userText: 'I live in Shanghai and prefer async communication.'.padEnd(300, '.'),
          assistantText: 'Got it.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'user shared location and async preference',
          salience: 0.85,
          decision: 'memorize',
          memory: {
            kind: 'user_profile',
            text: 'User lives in Shanghai and prefers async communication.',
            tags: ['location', 'work'],
          },
        }),
      },
    );
    assert.equal(result.skipped, false);
    assert.equal(result.decision, 'memorize');
    assert.ok(result.memoryId, 'expected a memory id');

    // Memory landed in memory_v3 (legacy addMemory dual-writes).
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.equal(memories.length, 1);
    assert.match(memories[0]!.text, /Shanghai/);
    assert.equal(memories[0]!.id, result.memoryId);
    assert.equal(memories[0]!.source, 'legacy:user_profile');

    // Evolution_run mirror — chat_burst, completed, refs_produced.memory.
    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'completed');
    assert.equal(runs[0]!.memories_written, 1);
    assert.equal(runs[0]!.skills_added, 0);
    assert.deepEqual(runs[0]!.refs_produced, { memory: [result.memoryId] });
    assert.ok(runs[0]!.duration_ms !== null);
  });
});

test('chat_burst: create_skill writes skill + pointer memory + refs_produced both', async () => {
  await withTempHome(async () => {
    const result = await runCrystallize(
      makeCrystallizeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: 'agent:main:proactive-ai:chat:card:run_card_2',
          userText: 'When I ask about pricing always respond with a structured table.'.padEnd(300, '.'),
          assistantText: 'Understood.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'user expects structured pricing responses',
          salience: 0.9,
          decision: 'create_skill',
          skill: {
            title: 'Respond to pricing questions with a markdown table',
            triggers: ['when the user asks about pricing'],
            bodyMarkdown: '## When to use\nPricing questions.\n\n## How to respond\nUse a markdown table with three columns.',
          },
        }),
      },
    );
    assert.equal(result.decision, 'create_skill');
    assert.ok(result.skillId, 'expected a skill id');

    // Skill landed in skill_index (legacy addUserSkill redirects to v3 addSkill).
    const skills = await listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.id, result.skillId);
    assert.equal(skills[0]!.title, 'Respond to pricing questions with a markdown table');
    assert.equal(skills[0]!.status, 'enabled');

    // A pointer memory is also written so the skill's origin is searchable.
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.ok(memories.length >= 1, 'create_skill should also sediment a pointer memory');

    // Evolution_run mirror — chat_burst with skills_added=1 + memories_written=1
    // (the pointer memory) + refs_produced for both skill_index and memory.
    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'completed');
    assert.equal(runs[0]!.skills_added, 1);
    assert.equal(runs[0]!.memories_written, 1, 'pointer memory bumps the counter');
    assert.deepEqual(runs[0]!.refs_produced.skill_index, [result.skillId]);
    assert.equal(runs[0]!.refs_produced.memory!.length, 1);
    assert.equal(runs[0]!.refs_produced.memory![0], memories[0]!.id);
  });
});

test('chat_burst: discard decision still creates a completed evolution_run with zero deltas', async () => {
  await withTempHome(async () => {
    const result = await runCrystallize(
      makeCrystallizeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: 'agent:main:proactive-ai:chat:card:run_card_3',
          userText: 'casual chat about the weather'.padEnd(300, '.'),
          assistantText: 'mhm',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'small talk, nothing to keep',
          salience: 0.1,
          decision: 'discard',
        }),
      },
    );
    assert.equal(result.decision, 'discard');
    assert.equal(result.memoryId, undefined);
    assert.equal(result.skillId, undefined);

    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.equal(memories.length, 0);
    const skills = await listSkills();
    assert.equal(skills.length, 0);

    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1, 'we still record observability for skipped/discarded attempts');
    assert.equal(runs[0]!.status, 'completed');
    assert.equal(runs[0]!.memories_written, 0);
    assert.equal(runs[0]!.skills_added, 0);
  });
});

// ── 2. daily_dream (auto + manual through dreaming) ──────────────────────

const DREAM_SYNTHESIS_FIXTURE = {
  summary: {
    kind: 'updated',
    text: 'Quiet day, a couple of recurring patterns continued.',
    highlights: ['User stuck to morning commute pattern', 'Picked up a new coffee shop habit'],
  },
  candidateCards: [],
  journalMarkdown: '# Dream journal\n\nUser kept their morning commute pattern.\nNew coffee shop habit emerged near home.',
  interestTopics: ['coffee', 'commute'],
  goalDelta: {
    changes: [{
      action: 'create',
      key: 'morning-coffee-routine',
      reason: 'consistent pattern observed for 7 days',
      before: null,
      after: { title: 'Maintain morning coffee routine', priority: 'low' },
    }],
  },
};

test('daily_dream (auto): writes dream_run + evolution_run + applyProfile materializes facts/interests/goals', async () => {
  await withTempHome(async () => {
    // Profile must exist for setFact / setPreference to actually persist
    // (they use UPDATE without WHERE — see db.ts setProfileJsonField).
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    const api = makeDreamingApi(DREAM_SYNTHESIS_FIXTURE);
    const { run, detail } = await runDreaming({ api, trigger: 'auto' });

    assert.equal(run.status, 'completed');
    assert.equal(run.trigger, 'auto');
    assert.ok(run.profile_delta, 'profile_delta must be present');
    assert.ok(run.goal_delta, 'goal_delta must be present');
    assert.equal(run.goal_delta!.changes.length, 1);
    assert.match(detail.dreamMarkdown, /Dream journal/);

    // Evolution_run mirror — daily_dream regardless of trigger='auto'|'manual'.
    const evolRuns = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 5 });
    assert.equal(evolRuns.length, 1);
    assert.equal(evolRuns[0]!.status, 'completed');
    assert.equal(evolRuns[0]!.profile_updated, true);
    // buildProfileDelta always produces facts + preferences + snapshots.
    assert.ok(evolRuns[0]!.profile_changed_keys.includes('facts'));
    assert.ok(evolRuns[0]!.profile_changed_keys.includes('preferences'));
    // interests gets a new key when interestTopics is non-empty.
    assert.ok(evolRuns[0]!.profile_changed_keys.includes('interests'));

    // Phase 2a: write-through, no separate apply step. The dream's
    // commit already wrote profile.facts.dreaming + interests-as-memory +
    // goals — assert they exist immediately, no apply call needed.
    assert.ok(run.applied_at, 'applied_at must be stamped during the run');
    assert.ok(run.goals_applied_at, 'goals_applied_at must be stamped during the run');

    const profile = await getProfile();
    assert.ok(profile);
    assert.ok((profile!.facts as Record<string, unknown>).dreaming, 'facts.dreaming key must be set');

    const interests = await listInterests({ limit: 50 });
    const interestKeys = interests.map((i) => i.key).sort();
    assert.deepEqual(interestKeys, ['coffee', 'commute']);

    // refs_produced lists the memory ids (Phase 2c: interests now live
    // in memory{subject:'topic:*'} with deterministic id 'interest:<kind>:<key>')
    // and goal keys actually touched.
    const evolAfter = (await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 1 }))[0]!;
    assert.deepEqual((evolAfter.refs_produced.memory ?? []).sort(),
      ['interest:topic:coffee', 'interest:topic:commute']);
    assert.deepEqual(evolAfter.refs_produced.goals, ['morning-coffee-routine']);
    assert.equal(evolAfter.memories_written, 2,
      'Phase 2c: interests counted as memories_written');
  });
});

test('manual dream: same flow as auto but trigger="manual" recorded on dream_runs', async () => {
  await withTempHome(async () => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });
    const api = makeDreamingApi(DREAM_SYNTHESIS_FIXTURE);
    const { run } = await runDreaming({ api, trigger: 'manual' });

    assert.equal(run.trigger, 'manual', 'manual dream stamps trigger="manual" on dream_runs');
    assert.equal(run.status, 'completed');
    assert.ok(run.applied_at, 'manual dreams also write through during the run');

    const evolRuns = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 5 });
    assert.equal(evolRuns.length, 1);
    assert.match(evolRuns[0]!.context_summary ?? '', /trigger=manual/);

    const interests = await listInterests({ limit: 50 });
    assert.equal(interests.length, 2);
  });
});

test('daily_dream: failure path records dream_run.failed + evolution_run.failed', async () => {
  await withTempHome(async () => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });
    // Synthesis missing journalMarkdown → dream throws.
    const api = makeDreamingApi({ summary: { kind: 'no_new_data', text: 'nothing' } });
    await assert.rejects(
      runDreaming({ api, trigger: 'auto' }),
      /journalMarkdown|invalid JSON/i,
    );

    // The evolution_run was opened then marked failed.
    const evolRuns = await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 5 });
    assert.equal(evolRuns.length, 1);
    assert.equal(evolRuns[0]!.status, 'failed');
    assert.ok(evolRuns[0]!.error_message);
  });
});

// ── 3. manual via pin evolution CLI (pure bookkeeping) ───────────────────

test('manual via pin evolution CLI: full lifecycle records all deltas', async () => {
  await withTempHome(async () => {
    const created = decode(await handleEvolution([
      'create',
      '--triggerKind', 'manual',
      '--contextSummary', 'manual reconciliation by ops',
    ]));
    assert.equal(created.ok, true);
    const id = created.data.run.id;

    await handleEvolution(['delta',
      '--id', id,
      '--memoriesWritten', '2',
      '--skillsAdded', '1',
      '--profileUpdated', 'true',
      '--profileChangedKeys', 'facts,preferences',
    ]);
    await handleEvolution(['refs', 'consumed',
      '--id', id, '--table', 'personal_signals', '--ids', 's1,s2,s3',
    ]);
    await handleEvolution(['refs', 'produced',
      '--id', id, '--table', 'memory', '--ids', 'm1,m2',
    ]);
    await handleEvolution(['refs', 'produced',
      '--id', id, '--table', 'skill_index', '--ids', 'sk1',
    ]);
    const completed = decode(await handleEvolution([
      'complete', '--id', id, '--llmTokens', '1234', '--durationMs', '4567',
    ]));
    assert.equal(completed.ok, true);

    const final = await getEvolutionRun(id);
    assert.ok(final);
    assert.equal(final!.trigger_kind, 'manual');
    assert.equal(final!.status, 'completed');
    assert.equal(final!.memories_written, 2);
    assert.equal(final!.skills_added, 1);
    assert.equal(final!.profile_updated, true);
    assert.deepEqual(final!.profile_changed_keys, ['facts', 'preferences']);
    assert.deepEqual(final!.refs_consumed, { personal_signals: ['s1', 's2', 's3'] });
    assert.deepEqual(final!.refs_produced, {
      memory: ['m1', 'm2'],
      skill_index: ['sk1'],
    });
    assert.equal(final!.llm_tokens, 1234);
    assert.equal(final!.duration_ms, 4567);
  });
});

test('manual via pin evolution CLI: fail path records error + status', async () => {
  await withTempHome(async () => {
    const created = decode(await handleEvolution([
      'create', '--triggerKind', 'manual',
    ]));
    const id = created.data.run.id;

    const failed = decode(await handleEvolution([
      'fail', '--id', id, '--error', 'integration test failure',
    ]));
    assert.equal(failed.ok, true);

    const final = await getEvolutionRun(id);
    assert.equal(final!.status, 'failed');
    assert.equal(final!.error_message, 'integration test failure');
  });
});

// ── 4. Three triggers coexist ─────────────────────────────────────────────

test('all three triggers coexist: pin evolution recent returns each kind', async () => {
  await withTempHome(async () => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    // 1) chat_burst — memorize.
    await runCrystallize(
      makeCrystallizeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: 'agent:main:proactive-ai:chat:card:run_combo_1',
          userText: 'I am vegetarian.'.padEnd(300, '.'),
          assistantText: 'Noted.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'dietary preference',
          salience: 0.7,
          decision: 'memorize',
          memory: { kind: 'user_profile', text: 'User is vegetarian.', tags: ['diet'] },
        }),
      },
    );

    // 2) daily_dream auto.
    await runDreaming({
      api: makeDreamingApi(DREAM_SYNTHESIS_FIXTURE),
      trigger: 'auto',
    });

    // 3) manual via CLI.
    const created = decode(await handleEvolution(['create', '--triggerKind', 'manual']));
    await handleEvolution(['delta', '--id', created.data.run.id, '--memoriesWritten', '5']);
    await handleEvolution(['complete', '--id', created.data.run.id]);

    // All three are listed.
    const all = await listEvolutionRuns({ limit: 50 });
    const byKind = new Map<string, number>();
    for (const r of all) byKind.set(r.trigger_kind, (byKind.get(r.trigger_kind) ?? 0) + 1);
    assert.equal(byKind.get('chat_burst'), 1);
    assert.equal(byKind.get('daily_dream'), 1);
    assert.equal(byKind.get('manual'), 1);

    // pin evolution recent --kind <X> filters correctly.
    const dreams = decode(await handleEvolution(['recent', '--kind', 'daily_dream']));
    assert.equal(dreams.data.count, 1);
    const bursts = decode(await handleEvolution(['recent', '--kind', 'chat_burst']));
    assert.equal(bursts.data.count, 1);
    const manuals = decode(await handleEvolution(['recent', '--kind', 'manual']));
    assert.equal(manuals.data.count, 1);

    // Persisted side effects: 1 memory (chat_burst), 0 skills, 2 interests
    // (from dream), profile.facts.dreaming key set — all already there
    // because both triggers write through during the run (Phase 2a).
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.ok(memories.length >= 1, 'chat_burst seeded a memory');

    const dreamRun = (await listEvolutionRuns({ triggerKind: 'daily_dream', limit: 1 }))[0]!;
    assert.equal(dreamRun.status, 'completed');
    assert.equal(dreamRun.profile_updated, true, 'dream wrote profile during the run');
  });
});

test('all three triggers coexist: chat_burst + dream side effects survive together in one tmpHome', async () => {
  await withTempHome(async () => {
    await upsertProfile({ displayName: 'Tester', locale: 'en', timezone: 'UTC' });

    // chat_burst → 1 memory
    const cb = await runCrystallize(
      makeCrystallizeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: 'agent:main:proactive-ai:chat:card:run_x',
          userText: 'I prefer email replies on weekdays only.'.padEnd(300, '.'),
          assistantText: 'OK.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'communication preference',
          salience: 0.8,
          decision: 'memorize',
          memory: { kind: 'user_profile', text: 'User prefers email on weekdays only.', tags: ['comms'] },
        }),
      },
    );
    assert.ok(cb.memoryId);

    // daily_dream → profile facts + interests (write-through, no apply call)
    await runDreaming({
      api: makeDreamingApi(DREAM_SYNTHESIS_FIXTURE),
      trigger: 'auto',
    });

    // Final state (Phase 2c): 3 active memory rows total — 1 from
    // chat_burst (the explicit memorize) + 2 dream interests now living
    // in memory{subject:'topic:*'}. Plus profile.facts.dreaming.
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.equal(memories.length, 3);
    const memoryIds = memories.map((m) => m.id).sort();
    assert.ok(memoryIds.includes(cb.memoryId!));
    assert.ok(memoryIds.includes('interest:topic:coffee'));
    assert.ok(memoryIds.includes('interest:topic:commute'));

    // listInterests is now a thin projection over memory; same observable.
    const interests = await listInterests({ limit: 50 });
    const keys = interests.map((i) => i.key).sort();
    assert.deepEqual(keys, ['coffee', 'commute']);

    const profile = await getProfile();
    assert.ok(profile);
    assert.ok((profile!.facts as Record<string, unknown>).dreaming);
  });
});
