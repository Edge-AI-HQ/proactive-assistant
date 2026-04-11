import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";

import { PinDatabaseManager } from "../../db/database.js";
import { MemoryRepository } from "./repository.js";

const createRepository = async (): Promise<{
  repository: MemoryRepository;
  cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "pin-memory-repo-"));
  const manager = new PinDatabaseManager(root);
  await manager.init();
  const database = manager.open("pin");

  return {
    repository: new MemoryRepository(database),
    cleanup: async () => {
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("MemoryRepository records events and searches them within one profile", async () => {
  const { repository, cleanup } = await createRepository();

  try {
    const first = await repository.recordEvent({
      profileId: "default",
      source: "chat",
      kind: "user_said",
      subjectType: "preference",
      subjectKey: "work-focus",
      text: "User wants to focus on work this week",
      confidence: 0.95,
    });

    await repository.recordEvent({
      profileId: "default",
      source: "feedback",
      kind: "user_confirmed",
      subjectType: "topic",
      subjectKey: "supabase",
      text: "User confirmed a Supabase issue card",
      confidence: 0.85,
    });

    assert.ok(first.id.startsWith("mev_"));

    const searched = await repository.searchEvents("default", {
      query: "Supabase",
      limit: 10,
    });
    assert.equal(searched.length, 1);
    assert.equal(searched[0]?.subjectKey, "supabase");
  } finally {
    await cleanup();
  }
});

test("MemoryRepository keeps profile data isolated for events and entries", async () => {
  const { repository, cleanup } = await createRepository();

  try {
    await repository.recordEvent({
      profileId: "default",
      source: "chat",
      kind: "user_said",
      subjectType: "project",
      subjectKey: "pin-ai",
      text: "Default profile event",
      confidence: 0.8,
    });

    await repository.recordEvent({
      profileId: "other",
      source: "chat",
      kind: "user_said",
      subjectType: "project",
      subjectKey: "other-project",
      text: "Other profile event",
      confidence: 0.8,
    });

    await repository.upsertEntry({
      profileId: "default",
      category: "project",
      text: "User is actively working on PIN AI",
      sourceEventIds: ["evt_a", "evt_b"],
      evidenceCount: 2,
      score: 0.9,
    });

    await repository.upsertEntry({
      profileId: "other",
      category: "project",
      text: "Other profile summary",
      sourceEventIds: ["evt_c"],
      evidenceCount: 1,
      score: 0.4,
    });

    const defaultEvents = await repository.listEvents("default", { limit: 10 });
    const otherEvents = await repository.listEvents("other", { limit: 10 });
    const defaultEntries = await repository.listEntries("default", { limit: 10 });
    const otherEntries = await repository.listEntries("other", { limit: 10 });

    assert.equal(defaultEvents.length, 1);
    assert.equal(otherEvents.length, 1);
    assert.equal(defaultEntries.length, 1);
    assert.equal(otherEntries.length, 1);
    assert.equal(defaultEntries[0]?.text.includes("PIN AI"), true);
    assert.equal(otherEntries[0]?.text, "Other profile summary");
  } finally {
    await cleanup();
  }
});

test("MemoryRepository upserts entries and can suppress them without deleting evidence", async () => {
  const { repository, cleanup } = await createRepository();

  try {
    const created = await repository.upsertEntry({
      profileId: "default",
      category: "constraint",
      text: "User does not want travel cards right now",
      sourceEventIds: ["evt_travel_1"],
      evidenceCount: 1,
      score: 0.7,
    });

    const updated = await repository.upsertEntry({
      profileId: "default",
      category: "constraint",
      text: "User does not want travel cards right now",
      sourceEventIds: ["evt_travel_1", "evt_travel_2"],
      evidenceCount: 2,
      score: 0.92,
    });

    assert.equal(updated.id, created.id);
    assert.equal(updated.evidenceCount, 2);
    assert.deepEqual(updated.sourceEventIds, ["evt_travel_1", "evt_travel_2"]);

    const suppressed = await repository.suppressEntry("default", updated.id, {
      reason: "stale",
    });

    assert.ok(suppressed);
    assert.equal(suppressed?.status, "suppressed");
    assert.equal(suppressed?.metadata?.reason, "stale");

    const activeOnly = await repository.listEntries("default", {
      limit: 10,
      status: "active",
    });
    const allEntries = await repository.listEntries("default", {
      limit: 10,
    });

    assert.equal(activeOnly.length, 0);
    assert.equal(allEntries.length, 1);
    assert.equal(allEntries[0]?.status, "suppressed");
  } finally {
    await cleanup();
  }
});
