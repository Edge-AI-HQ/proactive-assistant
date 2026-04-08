import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PinDatabaseManager } from "../../db/database.js";
import { ProfileRepository } from "../../../core/domains/profile/repository.js";

test("ProfileRepository supports create read update delete lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new ProfileRepository(manager.open("pin"));

    const created = await repository.create({
      id: "default",
      displayName: "Alice",
      locale: "en-US",
      timezone: "Asia/Shanghai",
      summary: "Demo profile",
      metadata: {
        source: "test",
      },
    });

    assert.equal(created.id, "default");
    assert.equal(created.displayName, "Alice");
    assert.equal(created.metadata.source, "test");

    const loaded = await repository.getById("default");
    assert.equal(loaded?.timezone, "Asia/Shanghai");

    const updated = await repository.update("default", {
      displayName: "Alice Updated",
      summary: "Updated profile",
      metadata: {
        source: "test",
        stage: "updated",
      },
    });

    assert.equal(updated?.displayName, "Alice Updated");
    assert.equal(updated?.metadata.stage, "updated");

    const allProfiles = await repository.list();
    assert.equal(allProfiles.length, 1);

    const deleted = await repository.delete("default");
    assert.equal(deleted, true);
    assert.equal(await repository.getById("default"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProfileRepository supports preferences goals and constraints sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-sections-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new ProfileRepository(manager.open("pin"));

    await repository.create({
      id: "default",
      displayName: "Alice",
    });

    const afterPreference = await repository.setPreference(
      "default",
      "content_topics",
      ["ai", "startups"],
    );
    assert.deepEqual(afterPreference?.preferences.content_topics, [
      "ai",
      "startups",
    ]);

    const afterGoal = await repository.upsertGoal("default", {
      key: "career",
      title: "Find startup opportunities",
      priority: "high",
    });
    assert.equal((afterGoal?.goals ?? [])[0]?.key, "career");
    assert.equal((afterGoal?.goals ?? [])[0]?.status, "active");

    const afterGoalClose = await repository.closeGoal("default", "career");
    assert.equal((afterGoalClose?.goals ?? [])[0]?.status, "closed");

    const afterConstraint = await repository.setConstraint(
      "default",
      "quiet_hours",
      "23:00-08:00",
    );
    assert.equal(afterConstraint?.constraints.quiet_hours, "23:00-08:00");

    const afterUnsetConstraint = await repository.unsetConstraint(
      "default",
      "quiet_hours",
    );
    assert.equal(afterUnsetConstraint?.constraints.quiet_hours, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ProfileRepository rolls up signals into interests and builds ranking snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-rollup-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new ProfileRepository(manager.open("pin"));

    await repository.create({
      id: "default",
      displayName: "Alice",
    });

    await repository.setConstraint("default", "quiet_hours", "23:00-08:00");
    await repository.addSignal("default", {
      kind: "liked",
      targetType: "topic",
      targetKey: "ai",
      source: "explicit",
    });
    await repository.addSignal("default", {
      kind: "disliked",
      targetType: "topic",
      targetKey: "celebrity-gossip",
      source: "explicit",
    });
    await repository.addSignal("default", {
      kind: "followed_up",
      targetType: "entity",
      targetKey: "OpenAI",
      source: "implicit",
    });

    const rollup = await repository.rollupSignals("default");
    assert.ok(rollup);
    assert.equal(rollup.signalsProcessed, 3);
    assert.equal(rollup.interestsUpdated >= 3, true);

    const topicInterests = await repository.listInterests("default", {
      kind: "topic",
    });
    assert.equal(topicInterests[0]?.key, "ai");
    assert.equal(topicInterests[0]?.status, "active");
    assert.equal(
      topicInterests.some((interest) => interest.key === "celebrity-gossip"),
      true,
    );

    const snapshot = await repository.buildSnapshot("default", "ranking");
    assert.ok(snapshot);
    assert.equal(snapshot.topPositiveTopics[0]?.key, "ai");
    assert.equal(
      snapshot.topPositiveTopics[0]?.facts.some((fact) => fact.code === "INTEREST_SCORE"),
      true,
    );
    assert.equal(snapshot.topNegativeTopics[0]?.key, "celebrity-gossip");
    assert.equal(snapshot.topEntities[0]?.key, "OpenAI");
    assert.equal(snapshot.activeConstraints[0]?.key, "quiet_hours");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
