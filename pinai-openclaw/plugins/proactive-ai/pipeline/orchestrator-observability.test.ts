/**
 * Tests for the SSE observability events added to runPipeline:
 *   - pipeline:context           (open signal count + summary load flags)
 *   - pipeline:iteration-summary (reasoning / iterationFeedback / rejected)
 *   - pipeline:thread-matches    (suppress / hold / refine / advance hits)
 *   - pipeline:complete signalDelta
 *
 * These events are read-only — they must not change the existing selection
 * behavior. The persistence test in orchestrator-persistence.test.ts still
 * guards that contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ingestPersonalSignals,
  applyCardOutcome,
  resetDbForTests,
} from '../db.ts';
import { runPipeline } from './orchestrator.ts';
import { makeIntentKey } from '../shared/intent-key.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-pipeline-obs-'));
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

function makeApi(agentText: string) {
  let lastSessionKey = '';
  return {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runtime: {
      subagent: {
        run: async ({ sessionKey }: { sessionKey: string }) => {
          lastSessionKey = sessionKey;
          return { runId: 'agent-run-1' };
        },
        waitForRun: async () => ({ status: 'ok' }),
        getSessionMessages: async ({ sessionKey }: { sessionKey: string }) => {
          assert.equal(sessionKey, lastSessionKey);
          return { messages: [{ role: 'assistant', content: agentText }] };
        },
      },
    },
  };
}

const TWO_CARDS_ONE_REJECTED = `\`\`\`json
{
  "reasoning": "Pulled gmail recent + signals open + cards recent.",
  "cards": [
    {
      "title": "Reply to Alice about Q2 plan",
      "whyNow": "Alice asked twice this week.",
      "summary": "Concrete reply to a peer-coordination request.",
      "primaryAction": { "label": "Send reply" },
      "goalBasket": "work",
      "sources": ["gmail"]
    },
    {
      "title": "Generic stay healthy reminder",
      "whyNow": "Just a generic reminder.",
      "summary": "Vague advice that fits any user.",
      "primaryAction": { "label": "Be healthy" },
      "goalBasket": "health",
      "sources": ["none"]
    }
  ],
  "evaluations": [
    { "cardId": "draft-1", "overall": 8.0, "pass": true, "feedback": "concrete" },
    { "cardId": "draft-2", "overall": 3.0, "pass": false, "feedback": "generic" }
  ],
  "iterationFeedback": "Drop the generic health card next time."
}
\`\`\``;

test('runPipeline emits pipeline:context with open signal count', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      {
        kind: 'moment', title: 'demo signal a', summary: 'a',
        salience: 0.5, confidence: 0.5, dedupeKey: 'demo-a',
      },
      {
        kind: 'moment', title: 'demo signal b', summary: 'b',
        salience: 0.5, confidence: 0.5, dedupeKey: 'demo-b',
      },
    ]);

    const events: Array<{ type: string; data: unknown }> = [];
    await runPipeline(
      makeApi(TWO_CARDS_ONE_REJECTED) as never,
      { maxIterations: 1, cardsPerIteration: 2, agentTimeoutMs: 1000 },
      (event) => events.push(event),
    );

    const ctx = events.find((e) => e.type === 'pipeline:context');
    assert.ok(ctx, 'expected pipeline:context to be emitted');
    const data = ctx.data as Record<string, unknown>;
    assert.equal(data['openSignalCount'], 2);
    assert.equal(typeof data['feedbackLoaded'], 'boolean');
    assert.equal(typeof data['cardsHistoryLoaded'], 'boolean');
    assert.equal(typeof data['skillsLoaded'], 'boolean');
  });
});

test('runPipeline emits pipeline:iteration-summary with reasoning and rejected cards', async () => {
  await withTempHome(async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    await runPipeline(
      makeApi(TWO_CARDS_ONE_REJECTED) as never,
      { maxIterations: 1, cardsPerIteration: 2, agentTimeoutMs: 1000 },
      (event) => events.push(event),
    );

    const summary = events.find((e) => e.type === 'pipeline:iteration-summary');
    assert.ok(summary, 'expected pipeline:iteration-summary to be emitted');
    const data = summary.data as {
      iteration: number;
      reasoning: string;
      iterationFeedback: string;
      generatedCount: number;
      passedCount: number;
      rejectedCount: number;
      rejectedCards: Array<{ title: string | null; goalBasket: string | null; overall: number | null; feedback: string | null }>;
    };
    assert.equal(data.iteration, 1);
    assert.equal(data.generatedCount, 2);
    assert.equal(data.passedCount, 1);
    assert.equal(data.rejectedCount, 1);
    assert.equal(data.rejectedCards[0]?.title, 'Generic stay healthy reminder');
    assert.equal(data.rejectedCards[0]?.goalBasket, 'health');
    assert.equal(data.rejectedCards[0]?.overall, 3.0);
    assert.equal(data.rejectedCards[0]?.feedback, 'generic');
    assert.equal(data.iterationFeedback, 'Drop the generic health card next time.');
    assert.match(data.reasoning, /Pulled gmail recent/);
  });
});

test('runPipeline emits pipeline:thread-matches when a candidate hits a suppress thread', async () => {
  await withTempHome(async () => {
    // Pre-seed an intent_thread_state with thread_decision='suppress' for the
    // intent key the agent will produce. We do this by replaying a dismiss
    // outcome on a card with the same intent_key.
    const intentKey = makeIntentKey('work', 'Reply to Alice about Q2 plan');
    await applyCardOutcome({
      cardId: 'historic-1',
      intentKey,
      goalBasket: 'work',
      outcome: 'dismiss',
      at: new Date().toISOString(),
    });

    const events: Array<{ type: string; data: unknown }> = [];
    await runPipeline(
      makeApi(TWO_CARDS_ONE_REJECTED) as never,
      { maxIterations: 1, cardsPerIteration: 2, agentTimeoutMs: 1000 },
      (event) => events.push(event),
    );

    const threadEv = events.find((e) => e.type === 'pipeline:thread-matches');
    assert.ok(threadEv, 'expected pipeline:thread-matches to be emitted');
    const data = threadEv.data as {
      suppressMatches: number;
      details: Array<{ title: string | null; threadDecision: string; latestCardOutcome: string }>;
    };
    assert.equal(data.suppressMatches, 1);
    const detail = data.details.find((d) => d.title === 'Reply to Alice about Q2 plan');
    assert.ok(detail);
    assert.equal(detail.threadDecision, 'suppress');
    assert.equal(detail.latestCardOutcome, 'dismiss');
  });
});

test('runPipeline pipeline:complete includes signalDelta', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      {
        kind: 'moment', title: 'demo signal', summary: 'x',
        salience: 0.5, confidence: 0.5, dedupeKey: 'demo-x',
      },
    ]);

    const events: Array<{ type: string; data: unknown }> = [];
    await runPipeline(
      makeApi(TWO_CARDS_ONE_REJECTED) as never,
      { maxIterations: 1, cardsPerIteration: 2, agentTimeoutMs: 1000 },
      (event) => events.push(event),
    );

    const complete = events.find((e) => e.type === 'pipeline:complete');
    assert.ok(complete);
    const data = complete.data as {
      signalDelta: { openBefore: number; openAfter: number; consumedByRun: number };
    };
    // The agent in this test does not actually call `pin signals consume`,
    // so consumedByRun should be 0 and openAfter should equal openBefore.
    // What matters is the shape and that openBefore is captured.
    assert.equal(typeof data.signalDelta, 'object');
    assert.equal(data.signalDelta.openBefore, 1);
    assert.equal(data.signalDelta.openAfter, 1);
    assert.equal(data.signalDelta.consumedByRun, 0);
  });
});
