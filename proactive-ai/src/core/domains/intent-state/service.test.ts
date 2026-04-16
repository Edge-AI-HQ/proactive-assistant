import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreContext } from "../../context.js";
import { applyCardOutcome, applyChatDecision, listThreadStates, seedGeneratedCards } from "./service.js";

const cleanupTasks: Array<() => Promise<void>> = [];

async function createCtx(): Promise<CoreContext> {
  const root = await mkdtemp(join(tmpdir(), "pin-intent-state-"));
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

describe("intent-state service", () => {
  it("derives thread decision from the latest card outcome when no chat decision exists", async () => {
    const ctx = await createCtx();

    await seedGeneratedCards(ctx, {
      generatedAt: "2026-04-10T10:00:00.000Z",
      cards: [
        {
          cardId: "card_1",
          intentKey: "work:review-queue-with-alex",
          goalBasket: "work",
        },
      ],
    });

    await applyCardOutcome(ctx, {
      cardId: "card_1",
      intentKey: "work:review-queue-with-alex",
      goalBasket: "work",
      outcome: "confirm",
      at: "2026-04-10T10:05:00.000Z",
    });

    const states = await listThreadStates(ctx, {
      intentKeys: ["work:review-queue-with-alex"],
    });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      intentKey: "work:review-queue-with-alex",
      latestCardOutcome: "confirm",
      latestChatDecision: "none",
      threadDecision: "advance",
      hasAnyConfirmedCard: true,
      hasAnyDismissedCard: false,
    });
  });

  it("lets a chat decision override a dismiss outcome", async () => {
    const ctx = await createCtx();

    await seedGeneratedCards(ctx, {
      generatedAt: "2026-04-10T10:00:00.000Z",
      cards: [
        {
          cardId: "card_1",
          intentKey: "work:review-queue-with-alex",
          goalBasket: "work",
        },
      ],
    });

    await applyCardOutcome(ctx, {
      cardId: "card_1",
      intentKey: "work:review-queue-with-alex",
      goalBasket: "work",
      outcome: "dismiss",
      at: "2026-04-10T10:05:00.000Z",
    });

    await applyChatDecision(ctx, {
      cardId: "card_1",
      intentKey: "work:review-queue-with-alex",
      goalBasket: "work",
      decision: "refine",
      summary: "The topic still matters, but the action should be narrower.",
      nextAngles: ["batch review", "delegate low-risk PRs"],
      at: "2026-04-10T10:08:00.000Z",
    });

    const states = await listThreadStates(ctx, {
      intentKeys: ["work:review-queue-with-alex"],
    });

    expect(states[0]).toMatchObject({
      latestCardOutcome: "dismiss",
      latestChatDecision: "refine",
      latestChatSummary: "The topic still matters, but the action should be narrower.",
      nextAngles: ["batch review", "delegate low-risk PRs"],
      threadDecision: "refine",
      hasAnyDismissedCard: true,
    });
  });
});
