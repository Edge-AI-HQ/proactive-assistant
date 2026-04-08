import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { PinDatabaseManager } from "../../db/database.js";
import { WorldRepository } from "../../../core/domains/world/repository.js";

test("WorldRepository ingests and deduplicates items by normalized url", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new WorldRepository(manager.open("pin"));

    const first = await repository.ingest({
      provider: "google-news",
      title: "AI startup raises funding",
      url: "https://example.com/story?utm_source=rss",
      externalId: "story-1",
      summary: "First summary",
      publishedAt: "2026-04-02T08:00:00.000Z",
      query: "ai startups",
    });

    const second = await repository.ingest({
      provider: "google-news",
      title: "AI startup raises funding again",
      url: "https://example.com/story",
      externalId: "story-2",
      summary: "Updated summary",
      publishedAt: "2026-04-02T09:00:00.000Z",
      query: "venture",
    });

    assert.equal(first.id, second.id);

    const listed = await repository.list({ limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.streamType, "search");
    assert.equal(listed[0]?.summary, "Updated summary");
    assert.deepEqual(listed[0]?.searchQueries, ["ai startups", "venture"]);

    const searched = await repository.searchStored("venture", 10);
    assert.equal(searched.length, 1);
    assert.equal(searched[0]?.id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorldRepository preserves headline metadata on ingest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-headlines-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new WorldRepository(manager.open("pin"));

    const item = await repository.ingest({
      provider: "google-news",
      streamType: "headline",
      title: "US strikes Iran proxy sites",
      url: "https://example.com/geopolitics",
      publishedAt: "2026-04-02T10:00:00.000Z",
      query: "headline:geopolitics:global",
      topics: ["geopolitics"],
      regions: ["global"],
      importance: "high",
      metadata: { stream: "headline" },
    });

    assert.equal(item.streamType, "headline");
    assert.deepEqual(item.topics, ["geopolitics"]);
    assert.deepEqual(item.regions, ["global"]);
    assert.equal(item.importance, "high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorldRepository supports incremental filters by time and id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-filters-repo-"));

  try {
    const manager = new PinDatabaseManager({ dataRoot: root });
    await manager.init();
    const repository = new WorldRepository(manager.open("pin"));

    const first = await repository.ingest({
      provider: "google-news",
      title: "Alpha AI launch",
      url: "https://example.com/alpha",
      publishedAt: "2026-04-02T08:00:00.000Z",
      query: "alpha",
    });

    await delay(10);

    const second = await repository.ingest({
      provider: "google-news",
      title: "Beta Robotics launch",
      url: "https://example.com/beta",
      publishedAt: "2026-04-02T09:00:00.000Z",
      query: "robotics",
    });

    const sinceItems = await repository.list({
      since: "2026-04-02T08:30:00.000Z",
      limit: 10,
    });
    assert.equal(sinceItems.length, 1);
    assert.equal(sinceItems[0]?.title, "Beta Robotics launch");

    const queryItems = await repository.list({
      query: "robotics",
      limit: 10,
    });
    assert.equal(queryItems.length, 1);
    assert.equal(queryItems[0]?.title, "Beta Robotics launch");

    const sortedItems = await repository.list({ limit: 10 });
    const afterIdItems = await repository.list({
      afterId: sortedItems[0]?.id,
      limit: 10,
    });
    assert.equal(afterIdItems.length, 1);
    assert.equal(afterIdItems[0]?.title, "Alpha AI launch");

    const afterUpdatedItems = await repository.list({
      afterUpdatedAt: first.updatedAt,
      limit: 10,
    });
    assert.equal(afterUpdatedItems.length, 1);
    assert.equal(afterUpdatedItems[0]?.id, second.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
