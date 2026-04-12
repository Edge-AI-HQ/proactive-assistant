import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteDatabase } from "../../../core/db/sqlite_adapter.js";
import { GeneratedIntentCardRepository } from "../../../core/domains/cards/repository.js";

const cleanupTasks: Array<() => Promise<void>> = [];

const createTestDb = async (): Promise<SqliteDatabase> => {
  const root = await mkdtemp(join(tmpdir(), "pin-cards-test-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = new SqliteDatabase(join(dataDir, "pin.db"));
  cleanupTasks.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return db;
};

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) await task();
  }
});

describe("GeneratedIntentCardRepository", () => {
  it("recordBatch persists cards with normalized title keys", async () => {
    const db = await createTestDb();
    const repo = new GeneratedIntentCardRepository(db);

    const records = await repo.recordBatch({
      runId: "run_manual_1",
      generatedAt: "2026-04-10T10:00:00.000Z",
      cards: [
        {
          cardId: "card_1_1",
          goalBasket: "work",
          title: "Review queue with Alex!",
          titleKey: "review-queue-with-alex",
          whyNow: "Two PRs are blocked today.",
          summary: "Alex is waiting on your review before noon.",
          primaryActionLabel: "Review now",
          sources: ["calendar", "github"],
          metadata: { source: "pipeline" },
        },
        {
          cardId: "card_1_2",
          goalBasket: "health",
          title: "Book annual check-up",
          titleKey: "book-annual-check-up",
          whyNow: "Your last physical was 11 months ago.",
          summary: "A short appointment window is open next week.",
          primaryActionLabel: "Book next week",
          sources: ["calendar"],
        },
      ],
    });

    expect(records).toHaveLength(2);
    expect(records[0].id.startsWith("gic_")).toBe(true);
    expect(records[0].runId).toBe("run_manual_1");
    expect(records[0].cardId).toBe("card_1_1");
    expect(records[0].goalBasket).toBe("work");
    expect(records[0].titleKey).toBe("review-queue-with-alex");
    expect(records[0].sources).toEqual(["calendar", "github"]);
    expect(records[0].metadata).toEqual({ source: "pipeline" });
  });

  it("listRecent supports limit, basket, and since filters in descending order", async () => {
    const db = await createTestDb();
    const repo = new GeneratedIntentCardRepository(db);

    await repo.recordBatch({
      runId: "run_old",
      generatedAt: "2026-04-08T08:00:00.000Z",
      cards: [
        {
          cardId: "card_old",
          goalBasket: "work",
          title: "Review sprint board",
          titleKey: "review-sprint-board",
          whyNow: "Board grooming starts tomorrow.",
          summary: "You still have three unresolved blockers.",
          primaryActionLabel: "Review board",
          sources: ["jira"],
        },
      ],
    });

    await repo.recordBatch({
      runId: "run_new",
      generatedAt: "2026-04-10T10:00:00.000Z",
      cards: [
        {
          cardId: "card_new_1",
          goalBasket: "health",
          title: "Adjust evening walk plan",
          titleKey: "adjust-evening-walk-plan",
          whyNow: "Rain is forecast for the next two evenings.",
          summary: "A shorter indoor alternative avoids missing the streak.",
          primaryActionLabel: "Move walk indoors",
          sources: ["weather"],
        },
        {
          cardId: "card_new_2",
          goalBasket: "work",
          title: "Prepare Alex handoff",
          titleKey: "prepare-alex-handoff",
          whyNow: "Alex is OOO tomorrow afternoon.",
          summary: "A 10-minute brief prevents the queue from stalling.",
          primaryActionLabel: "Draft handoff",
          sources: ["calendar"],
        },
      ],
    });

    const latestTwo = await repo.listRecent({ limit: 2 });
    expect(latestTwo).toHaveLength(2);
    expect(latestTwo[0].cardId).toBe("card_new_2");
    expect(latestTwo[1].cardId).toBe("card_new_1");

    const workOnly = await repo.listRecent({ limit: 10, basket: "work" });
    expect(workOnly).toHaveLength(2);
    expect(workOnly[0].cardId).toBe("card_new_2");
    expect(workOnly[1].cardId).toBe("card_old");

    const recentOnly = await repo.listRecent({
      limit: 10,
      since: "2026-04-09T00:00:00.000Z",
    });
    expect(recentOnly).toHaveLength(2);
    expect(recentOnly.some((record) => record.cardId === "card_old")).toBe(false);
  });
});
