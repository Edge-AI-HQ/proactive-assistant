import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyCardOutcome,
  applyChatDecision,
  getFeedback,
  listRecentGeneratedCards,
  logFeedback,
  resetDbForTests,
  savePipelineRun,
} from "./db.ts";

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pin-proactive-db-"));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("listRecentGeneratedCards returns default threadContext and card outcomes update it", async () => {
  await withTempHome(async () => {
    await savePipelineRun({
      runId: "run_manual_1",
      status: "completed",
      totalIterations: 1,
      finalCards: [
        {
          id: "card_1",
          goalBasket: "work",
          title: "Review queue with Alex",
          whyNow: "Two PRs are blocked today.",
          summary: "Alex is waiting on your review before noon.",
          primaryAction: { label: "Review now", type: "confirm" },
          secondaryActions: [],
          confidence: 0.9,
          urgency: 0.8,
          importance: 0.85,
          sources: ["calendar"],
          agentChain: ["planner", "generator"],
          createdAt: "2026-04-10",
        },
      ],
      iterations: [],
    });

    let rows = await listRecentGeneratedCards({ limit: 10 });
    assert.equal(rows[0]?.intentKey, "work:review-queue-with-alex");
    assert.deepEqual(rows[0]?.threadContext, {
      intentKey: "work:review-queue-with-alex",
      latestCardOutcome: "none",
      hasAnyConfirmedCard: false,
      hasAnyDismissedCard: false,
      latestChatDecision: "none",
      latestChatSummary: null,
      nextAngles: [],
      threadDecision: "hold",
    });

    await applyCardOutcome({
      cardId: "card_1",
      intentKey: "work:review-queue-with-alex",
      goalBasket: "work",
      outcome: "dismiss",
    });

    rows = await listRecentGeneratedCards({ limit: 10 });
    assert.equal(rows[0]?.threadContext.latestCardOutcome, "dismiss");
    assert.equal(rows[0]?.threadContext.threadDecision, "suppress");

    await applyChatDecision({
      cardId: "card_1",
      intentKey: "work:review-queue-with-alex",
      goalBasket: "work",
      decision: "refine",
      summary: "The topic still matters, but the action should be narrower.",
      nextAngles: ["batch review", "delegate low-risk PRs"],
    });

    rows = await listRecentGeneratedCards({ limit: 10 });
    assert.equal(rows[0]?.threadContext.latestChatDecision, "refine");
    assert.equal(rows[0]?.threadContext.threadDecision, "refine");
    assert.deepEqual(rows[0]?.threadContext.nextAngles, ["batch review", "delegate low-risk PRs"]);
  });
});

test("logFeedback stores intent_key when provided via metadata", async () => {
  await withTempHome(async () => {
    const row = await logFeedback({
      kind: "card_action",
      action: "confirm",
      intentCardId: "card_2",
      basket: "wealth",
      metadata: {
        intentKey: "wealth:verify-emergency-fund-covers-3-6-months-of-expenses",
      },
    });

    const saved = await getFeedback(row.id);
    assert.equal(saved?.intent_key, "wealth:verify-emergency-fund-covers-3-6-months-of-expenses");
  });
});
