/**
 * Structural coverage for the card-chat (绘画类 / chat-card) evolution path.
 *
 * Card chats live behind the special session-key prefix
 *   `agent:main:proactive-ai:chat:card:<cardId>`
 * and feed the same crystallize counter as MainChat. The threshold-met
 * tick still fires runCrystallize → memory / skill writes → chat_burst
 * evolution_run, but a few card-specific structural invariants must hold:
 *   1. classifyChatSessionKind('card:...') === 'card'   (vs 'main')
 *   2. extractCardIdFromSessionKey returns the card id
 *   3. bumpCrystallizeTurn from card sessions counts toward the same
 *      threshold as main-chat turns (counter is shared)
 *   4. /crystallize/state.diagnostics.lastSessionKind reports 'card' once
 *      a card session has bumped the counter
 *   5. runCrystallize against a card session writes a real memory + emits
 *      a chat_burst evolution_run with refs_produced.memory set
 *   6. The session-opener line "The user opened <card>" is filtered out
 *      of the transcript (so it doesn't pollute the evaluator prompt)
 *
 * This complements evolution-three-triggers.test.ts which covers the
 * top-level "three triggers" matrix; here we drill into the card-chat
 * specifics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyChatSessionKind,
  extractCardIdFromSessionKey,
  isTrackableChatSessionKey,
  pairUserAssistantMessages,
  runCrystallize,
} from './service.ts';
import { DEFAULT_CRYSTALLIZE_CONFIG } from './types.ts';
import {
  bumpCrystallizeTurn,
  getCrystallizeState,
  listEvolutionRuns,
  listMemoryV3,
  listSkills,
  resetDbForTests,
} from '../db.ts';
import { resetRawDbForTests } from '../raw-db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-card-chat-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function makeApi() {
  return {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
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

const CARD_KEY = 'agent:main:proactive-ai:chat:card:run_pricing_card_42';
const MAIN_KEY = 'agent:main:proactive-ai:chat:main_session_99';

// ── 1. Session-key classification + card id parsing ─────────────────────

test('card session keys classify as kind="card" and yield the card id', () => {
  assert.equal(classifyChatSessionKind(CARD_KEY), 'card');
  assert.equal(extractCardIdFromSessionKey(CARD_KEY), 'run_pricing_card_42');
  assert.equal(isTrackableChatSessionKey(CARD_KEY), true);
});

test('main-chat session keys still classify as kind="main" (regression guard)', () => {
  assert.equal(classifyChatSessionKind(MAIN_KEY), 'main');
  assert.equal(extractCardIdFromSessionKey(MAIN_KEY), null);
  assert.equal(isTrackableChatSessionKey(MAIN_KEY), true);
});

test('non-chat session keys are NOT trackable (e.g. chat-feedback subagent)', () => {
  assert.equal(isTrackableChatSessionKey('agent:main:proactive-ai:chat-feedback:abc'), false);
  assert.equal(classifyChatSessionKind('agent:main:proactive-ai:chat-feedback:abc'), 'other');
});

// ── 2. Counter is shared between main + card sessions ──────────────────

test('bumpCrystallizeTurn from card sessions increments the same counter as main-chat',
  withTempHome(async () => {
    let state = await getCrystallizeState();
    assert.equal(state.turn_count, 0);

    await bumpCrystallizeTurn(MAIN_KEY);
    await bumpCrystallizeTurn(MAIN_KEY);
    await bumpCrystallizeTurn(CARD_KEY);
    await bumpCrystallizeTurn(CARD_KEY);
    await bumpCrystallizeTurn(CARD_KEY);

    state = await getCrystallizeState();
    assert.equal(state.turn_count, 5, 'main + card turns share one counter');
    // last_session_key is the most recent bumper — i.e. card.
    assert.equal(state.last_session_key, CARD_KEY);
  }));

// ── 3. Opener message filter (card-feedback handles it elsewhere) ──────

test('"The user opened ..." opener is dropped from card transcripts before evaluation', () => {
  const messages = [
    { role: 'user', content: 'The user opened run_pricing_card_42' },
    { role: 'assistant', content: 'Welcome — let me know what you need on pricing.' },
    { role: 'user', content: 'Always answer pricing questions with a structured table.' },
    { role: 'assistant', content: 'Got it.' },
  ];
  const turns = pairUserAssistantMessages(messages, CARD_KEY, DEFAULT_CRYSTALLIZE_CONFIG);
  assert.equal(turns.length, 1, 'opener turn must be filtered out');
  assert.equal(turns[0].userText, 'Always answer pricing questions with a structured table.');
  assert.equal(turns[0].sessionKey, CARD_KEY);
});

// ── 4. End-to-end: card-chat → memorize → memory + chat_burst run ──────

test('card-chat memorize: writes memory + chat_burst evolution_run + refs_produced',
  withTempHome(async () => {
    const result = await runCrystallize(
      makeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: CARD_KEY,
          userText: 'For this pricing card, prefer USD over EUR when both are quoted.'.padEnd(300, '.'),
          assistantText: 'Noted — defaulting to USD.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'card-driven currency preference',
          salience: 0.85,
          decision: 'memorize',
          memory: {
            kind: 'user_profile',
            text: 'For pricing decisions, prefer USD over EUR when both are quoted.',
            tags: ['pricing', 'currency'],
          },
        }),
      },
    );

    assert.equal(result.skipped, false);
    assert.equal(result.decision, 'memorize');
    assert.ok(result.memoryId);

    // The memory landed via real db.addMemory → memory_v3.
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.id, result.memoryId);
    assert.match(memories[0]!.text, /USD over EUR/);

    // Evolution_run mirror is chat_burst; refs_produced.memory has the id.
    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'completed');
    assert.equal(runs[0]!.memories_written, 1);
    assert.deepEqual(runs[0]!.refs_produced, { memory: [result.memoryId] });
  }));

// ── 5. End-to-end: card-chat → create_skill ────────────────────────────

test('card-chat create_skill: writes skill + pointer memory tagged from the card',
  withTempHome(async () => {
    const result = await runCrystallize(
      makeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: CARD_KEY,
          userText: 'When this kind of pricing card opens, default to a markdown table.'.padEnd(300, '.'),
          assistantText: 'Will do.',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'card-conditioned response style',
          salience: 0.9,
          decision: 'create_skill',
          skill: {
            title: 'Pricing card → markdown table',
            triggers: ['when a pricing card opens', 'for pricing comparison'],
            bodyMarkdown: '## When to use\nUser is in a pricing card chat.\n\n## How to respond\nUse a markdown table with three columns: option, price, notes.',
          },
        }),
      },
    );

    assert.equal(result.decision, 'create_skill');
    assert.ok(result.skillId);

    const skills = await listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.id, result.skillId);
    assert.equal(skills[0]!.title, 'Pricing card → markdown table');
    assert.equal(skills[0]!.status, 'enabled');

    // Pointer memory created so the skill's origin is searchable.
    const memories = await listMemoryV3({ status: 'active', limit: 50 });
    assert.ok(memories.length >= 1, 'pointer memory accompanies the skill');

    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.skills_added, 1);
    assert.equal(runs[0]!.memories_written, 1, 'pointer memory is counted');
    assert.deepEqual(runs[0]!.refs_produced.skill_index, [result.skillId]);
  }));

// ── 6. Card + main turns interleave; one tick handles whichever is recent ─

test('card + main turns interleaved → only the most-recent session is the transcript source',
  withTempHome(async () => {
    // Simulate: 3 main, then 4 card (total 7 turns, last_session_key=card).
    for (let i = 0; i < 3; i++) await bumpCrystallizeTurn(MAIN_KEY);
    for (let i = 0; i < 4; i++) await bumpCrystallizeTurn(CARD_KEY);

    const state = await getCrystallizeState();
    assert.equal(state.turn_count, 7);
    assert.equal(state.last_session_key, CARD_KEY);

    let observedSessionKey: string | null = null;
    await runCrystallize(
      makeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        // Stub: the production collectTurns reads from last_session_key, so
        // here we just assert what the tick sees and feed back a synthesis.
        collectTurns: async () => {
          const s = await getCrystallizeState();
          observedSessionKey = s.last_session_key;
          return [{
            sessionKey: s.last_session_key ?? '',
            userText: 'Stubbed user message that meets the minUserChars cap.'.padEnd(300, '.'),
            assistantText: 'OK',
            timestamp: null,
          }];
        },
        runEvaluator: async () => ({
          summary: 'mixed transcript', salience: 0.5, decision: 'discard',
        }),
      },
    );

    assert.equal(observedSessionKey, CARD_KEY,
      'crystallize tick samples the most-recent bumped session — card here');
  }));

// ── 7. Card-chat discard: still records evolution_run for observability ─

test('card-chat discard decision still records a chat_burst evolution_run',
  withTempHome(async () => {
    const result = await runCrystallize(
      makeApi(),
      { force: true, configOverride: { messageThreshold: 1, minUserChars: 10, cooldownMs: 0 } },
      {
        collectTurns: async () => ([{
          sessionKey: CARD_KEY,
          userText: 'small talk that the evaluator decides not to keep'.padEnd(300, '.'),
          assistantText: 'mhm',
          timestamp: null,
        }]),
        runEvaluator: async () => ({
          summary: 'low salience small talk',
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

    const runs = await listEvolutionRuns({ triggerKind: 'chat_burst', limit: 5 });
    assert.equal(runs.length, 1, 'observability mirror runs even on discard');
    assert.equal(runs[0]!.status, 'completed');
    assert.equal(runs[0]!.memories_written, 0);
    assert.equal(runs[0]!.skills_added, 0);
  }));
