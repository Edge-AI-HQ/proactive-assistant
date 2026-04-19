import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CoreContext } from "../../context.js";
import { getGeneratedCardByCardId, listRecentGeneratedCards, normalizeTitleKey, recordGeneratedBatch } from "./service.js";

const cleanupTasks: Array<() => Promise<void>> = [];

async function createCtx(): Promise<CoreContext> {
  const root = await mkdtemp(join(tmpdir(), "pin-cards-service-"));
  const dataRoot = join(root, "data");
  await mkdir(dataRoot, { recursive: true });
  cleanupTasks.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    env: { PIN_DATA_ROOT: dataRoot },
    homeDir: "/Users/test",
  };
}

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) await task();
  }
});

describe("normalizeTitleKey", () => {
  it("preserves unicode letters and numbers instead of collapsing Chinese titles", () => {
    expect(normalizeTitleKey("买房首付规划")).toBe("买房首付规划");
    expect(normalizeTitleKey("  季度 OKR 复盘  ")).toBe("季度-okr-复盘");
  });

  it("falls back to a stable untitled key when no slug-safe characters remain", () => {
    const key = normalizeTitleKey("!!!");

    expect(key).toMatch(/^untitled-[a-z0-9]+$/);
    expect(normalizeTitleKey("!!!")).toBe(key);
  });

  it("returns recent cards with default thread context and explicit intentKey", async () => {
    const ctx = await createCtx();

    await recordGeneratedBatch(ctx, {
      runId: "run_manual_1",
      generatedAt: "2026-04-10T10:00:00.000Z",
      cards: [
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
    });

    const rows = await listRecentGeneratedCards(ctx, { limit: "10" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.intentKey).toBe("work:review-queue-with-alex");
    expect(rows[0]?.threadContext).toEqual({
      intentKey: "work:review-queue-with-alex",
      latestCardOutcome: "none",
      hasAnyConfirmedCard: false,
      hasAnyDismissedCard: false,
      latestChatDecision: "none",
      latestChatSummary: null,
      nextAngles: [],
      threadDecision: "hold",
    });

    const card = await getGeneratedCardByCardId(ctx, { cardId: "card_1" });
    expect(card?.intentKey).toBe("work:review-queue-with-alex");
  });
});
