import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PinDatabaseManager } from "../../db/database.js";
import { ProfileRepository } from "./repository.js";

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
