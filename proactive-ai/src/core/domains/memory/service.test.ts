import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vitest";

import { PinDatabaseManager } from "../../db/database.js";
import { ProfileRepository } from "../profile/repository.js";
import { MemoryRepository } from "./repository.js";
import {
  buildMemoryContextPack,
  consolidateMemoryEvents,
} from "./service.js";

const createMemoryTestContext = async (): Promise<{
  root: string;
  profileRepository: ProfileRepository;
  memoryRepository: MemoryRepository;
  cleanup: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "pin-memory-service-"));
  const manager = new PinDatabaseManager(root);
  await manager.init();
  const database = manager.open("pin");

  return {
    root,
    profileRepository: new ProfileRepository(database),
    memoryRepository: new MemoryRepository(database),
    cleanup: async () => {
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("consolidateMemoryEvents promotes repeated evidence into reusable entries", async () => {
  const { profileRepository, memoryRepository, cleanup } =
    await createMemoryTestContext();

  try {
    await profileRepository.create({
      id: "default",
      displayName: "Alice",
      summary: "Busy builder",
    });

    await memoryRepository.recordEvent({
      profileId: "default",
      source: "chat",
      kind: "user_said",
      subjectType: "preference",
      subjectKey: "work-focus",
      text: "User wants to focus on work this week",
      confidence: 0.95,
    });

    await memoryRepository.recordEvent({
      profileId: "default",
      source: "feedback",
      kind: "user_confirmed",
      subjectType: "project",
      subjectKey: "repo:pin-ai",
      text: "User confirmed a PIN AI repo card",
      confidence: 0.8,
    });

    await memoryRepository.recordEvent({
      profileId: "default",
      source: "dreaming",
      kind: "dream_inferred",
      subjectType: "project",
      subjectKey: "repo:pin-ai",
      text: "PIN AI is an active ongoing project",
      confidence: 0.7,
    });

    const result = await consolidateMemoryEvents({
      profileId: "default",
      memoryRepository,
    });

    assert.equal(result.entriesUpdated, 2);

    const entries = await memoryRepository.listEntries("default", { limit: 10 });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.evidenceCount >= 1, true);
    assert.equal(
      entries.some((entry) => entry.text.includes("PIN AI")),
      true,
    );
  } finally {
    await cleanup();
  }
});

test("buildMemoryContextPack returns resident memories ordered by score", async () => {
  const { profileRepository, memoryRepository, cleanup } =
    await createMemoryTestContext();

  try {
    await profileRepository.create({
      id: "default",
      displayName: "Alice",
      summary: "Busy builder",
      timezone: "Asia/Shanghai",
    });

    await profileRepository.upsertGoal("default", {
      key: "career-growth",
      title: "Advance career",
      priority: "high",
    });

    await profileRepository.setPreference("default", "language", "zh-CN");
    await profileRepository.setConstraint("default", "quiet_hours", "23:00-08:00");

    await memoryRepository.upsertEntry({
      profileId: "default",
      category: "project",
      text: "User is actively working on PIN AI",
      sourceEventIds: ["evt_1", "evt_2"],
      evidenceCount: 2,
      score: 0.95,
    });

    await memoryRepository.upsertEntry({
      profileId: "default",
      category: "constraint",
      text: "User does not want travel cards right now",
      sourceEventIds: ["evt_3"],
      evidenceCount: 1,
      score: 0.65,
    });

    const pack = await buildMemoryContextPack({
      profileId: "default",
      memoryRepository,
      profileRepository,
    });

    assert.equal(pack.profile.displayName, "Alice");
    assert.equal((pack.profile.goals as Array<unknown>).length, 1);
    assert.equal(pack.residentMemories.length, 2);
    assert.equal(pack.residentMemories[0]?.score >= pack.residentMemories[1]?.score, true);
    assert.equal(pack.profile.preferences.language, "zh-CN");
  } finally {
    await cleanup();
  }
});

test("buildMemoryContextPack performs relevant recall by topic and favors recent evidence", async () => {
  const { profileRepository, memoryRepository, cleanup } =
    await createMemoryTestContext();

  try {
    await profileRepository.create({
      id: "default",
      displayName: "Alice",
      summary: "Busy builder",
    });

    await profileRepository.update("default", {
      interests: [
        {
          id: "interest_1",
          kind: "topic",
          key: "supabase",
          score: 0.9,
          confidence: 0.8,
          evidenceCount: 3,
          lastSignalAt: new Date().toISOString(),
          status: "active",
        },
      ],
    });

    await memoryRepository.upsertEntry({
      profileId: "default",
      category: "project",
      text: "Supabase issues in PIN AI are usually worth immediate review",
      sourceEventIds: ["evt_supabase"],
      evidenceCount: 1,
      score: 0.8,
      metadata: { subjectKey: "supabase" },
    });

    await memoryRepository.upsertEntry({
      profileId: "default",
      category: "project",
      text: "Travel planning is currently a low priority topic",
      sourceEventIds: ["evt_travel"],
      evidenceCount: 1,
      score: 0.6,
      metadata: { subjectKey: "travel" },
    });

    await memoryRepository.recordEvent({
      profileId: "default",
      source: "feedback",
      kind: "user_confirmed",
      subjectType: "topic",
      subjectKey: "supabase",
      text: "User confirmed a Supabase issue card today",
      confidence: 0.95,
      occurredAt: new Date().toISOString(),
    });

    await memoryRepository.recordEvent({
      profileId: "default",
      source: "feedback",
      kind: "user_dismissed",
      subjectType: "topic",
      subjectKey: "travel",
      text: "User dismissed a travel card last month",
      confidence: 0.6,
      occurredAt: "2026-03-01T08:00:00.000Z",
    });

    const pack = await buildMemoryContextPack({
      profileId: "default",
      queryText: "new Supabase issue email",
      memoryRepository,
      profileRepository,
    });

    assert.equal(pack.relevantMemories.length > 0, true);
    assert.equal(pack.relevantMemories[0]?.text.includes("Supabase"), true);
    assert.equal(pack.recentEvents.length > 0, true);
    assert.equal(pack.recentEvents[0]?.subjectKey, "supabase");
  } finally {
    await cleanup();
  }
});
