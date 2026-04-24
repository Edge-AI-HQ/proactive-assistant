import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetDbForTests, listPipelineRuns, listRecentGeneratedCards, listCardEvaluationsByRun } from '../db.ts';
import { runPipeline } from './orchestrator.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-pipeline-persist-'));
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

test('runPipeline persists run, generated cards, and evaluations before complete', async () => {
  await withTempHome(async () => {
    const agentText = `\`\`\`json
{
  "reasoning": "Used current personal data.",
  "cards": [
    {
      "title": "Review Scholar alerts",
      "whyNow": "Two new Scholar alerts arrived today.",
      "summary": "The current Gmail data contains fresh Scholar alerts.",
      "primaryAction": { "label": "Open alerts" },
      "goalBasket": "growth",
      "intentKey": "growth:scholar-alerts",
      "sources": ["gmail"]
    }
  ],
  "evaluations": [
    {
      "cardId": "draft-1",
      "overall": 8.2,
      "pass": true,
      "dimensions": {
        "relevance": 8,
        "actionability": 8,
        "whyNowClarity": 9,
        "novelty": 8,
        "decisionCompression": 8
      }
    }
  ],
  "iterationFeedback": "keep"
}
\`\`\``;
    const events: Array<{ type: string; data: unknown }> = [];

    const result = await runPipeline(
      makeApi(agentText) as never,
      { maxIterations: 1, cardsPerIteration: 1, agentTimeoutMs: 1000 },
      (event) => events.push(event),
    );

    const eventTypes = events.map((event) => event.type);
    assert.ok(eventTypes.includes('pipeline:persisted'));
    assert.ok(eventTypes.indexOf('pipeline:persisted') < eventTypes.indexOf('pipeline:complete'));

    const runs = await listPipelineRuns({ limit: 5 });
    assert.equal(runs[0]?.run_id, result.runId);
    assert.equal(Array.isArray(runs[0]?.final_cards), true);

    const cards = await listRecentGeneratedCards({ limit: 5 });
    assert.equal(cards[0]?.cardId, result.finalCards[0]?.id);

    const evaluations = await listCardEvaluationsByRun(result.runId);
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0]?.overall, 8.2);
  });
});

test('runPipeline drops generic future Home calendar cards from final selection', async () => {
  await withTempHome(async () => {
    const agentText = `\`\`\`json
{
  "reasoning": "Generated one placeholder calendar card and one concrete work card.",
  "cards": [
    {
      "title": "确认6月12日起连续Home标记是休假还是远程办公",
      "whyNow": "日历显示6月12日-7月23日连续42天标记为Home。",
      "summary": "Google Calendar显示连续Home占位符，可能是休假、远程办公或占位符。",
      "primaryAction": { "label": "确认Home标记含义" },
      "goalBasket": "life",
      "sources": ["pin raw gcal - 42 days Home events Jun-Jul"]
    },
    {
      "title": "回复boliang关于非OpenClaw内存方案的讨论",
      "whyNow": "boliang今天直接询问memory不用OpenClaw能否实现类似效果。",
      "summary": "这个问题直接落在用户的RAG和个性化数据引擎经验上。",
      "primaryAction": { "label": "回复技术判断" },
      "goalBasket": "work",
      "sources": ["pin signals recent - boliang DM"]
    }
  ],
  "evaluations": [
    { "cardId": "draft-1", "overall": 9.0, "pass": true },
    { "cardId": "draft-2", "overall": 8.0, "pass": true }
  ],
  "iterationFeedback": "keep"
}
\`\`\``;

    const result = await runPipeline(
      makeApi(agentText) as never,
      { maxIterations: 1, cardsPerIteration: 2, agentTimeoutMs: 1000 },
    );

    assert.equal(result.finalCards.length, 1);
    assert.equal(result.finalCards[0]?.title, '回复boliang关于非OpenClaw内存方案的讨论');
  });
});
