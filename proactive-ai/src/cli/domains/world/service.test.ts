import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  fetchHeadlines,
  shortlistWorldItems,
  buildWorldContext,
  runWorldIndexRefresh,
  searchWorldItems,
} from "./service.js";
import { PinDatabaseManager } from "../../../core/db/database.js";
import { ProfileRepository } from "../profile/repository.js";

test("fetchHeadlines supports SEC official RSS feed with required user agent", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-sec-headlines-"));
  const originalFetch = globalThis.fetch;

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    let requestedUrl = "";
    let requestedUserAgent = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUserAgent = String(new Headers(init?.headers).get("user-agent") ?? "");

      return new Response(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Press Releases</title>
            <item>
              <title>SEC Announces Roundtable on Options Market Structure</title>
              <link>https://www.sec.gov/newsroom/press-releases/2026-33</link>
              <guid>sec-1</guid>
              <description>Official SEC press release.</description>
              <pubDate>Thu, 02 Apr 2026 16:44:29 -0400</pubDate>
            </item>
          </channel>
        </rss>`, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    }) as typeof fetch;

    const result = await fetchHeadlines(runtime, {
      provider: "sec",
      limit: "10",
    });

    const data = result.stdout.data as { provider: string; count: number; items: Array<{ title: string }> };
    assert.equal(result.exitCode, 0);
    assert.equal(requestedUrl, "https://www.sec.gov/news/pressreleases.rss");
    assert.equal(requestedUserAgent.includes("PINAI"), true);
    assert.equal(data.provider, "sec");
    assert.equal(data.count, 1);
    assert.equal(data.items[0]?.title, "SEC Announces Roundtable on Options Market Structure");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("fetchHeadlines supports Federal Reserve official RSS feed", { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-fed-headlines-"));
  const originalFetch = globalThis.fetch;

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    let requestedUrl = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      return new Response(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>FRB: Press Release - All Releases</title>
            <item>
              <title>Federal Reserve Board releases annual audited financial statements</title>
              <link>https://www.federalreserve.gov/newsevents/pressreleases/other20260325a.htm</link>
              <guid>fed-1</guid>
              <description>All recent press releases from the Federal Reserve Board.</description>
              <pubDate>Wed, 25 Mar 2026 18:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>`, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    }) as typeof fetch;

    const result = await fetchHeadlines(runtime, {
      provider: "fed",
      limit: "10",
    });

    const data = result.stdout.data as { provider: string; count: number; items: Array<{ title: string }> };
    assert.equal(result.exitCode, 0);
    assert.equal(requestedUrl, "https://www.federalreserve.gov/feeds/press_all.xml");
    assert.equal(data.provider, "fed");
    assert.equal(data.count, 1);
    assert.equal(
      data.items[0]?.title,
      "Federal Reserve Board releases annual audited financial statements",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("runWorldIndexRefresh builds semantic index for stored world items", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-index-refresh-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>News</title>
          <item>
            <title>OpenAI releases new agent tooling</title>
            <link>https://example.com/openai-agents</link>
            <guid>news-1</guid>
            <description>Agent tooling expands across enterprise workflows.</description>
            <pubDate>2026-04-03T08:00:00.000Z</pubDate>
          </item>
        </channel>
      </rss>`;

    runtime.env.PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE = `data:text/xml,${encodeURIComponent(feed)}`;

    const { searchNews } = await import("./service.js");
    await searchNews(runtime, {
      query: "OpenAI agents",
      limit: "10",
      provider: "google-news",
    });

    const refresh = await runWorldIndexRefresh(
      runtime,
      { all: true, limit: 10 },
      {
        embeddingProvider: {
          model: "fake-embedding-model",
          async embedTexts(texts) {
            return texts.map(() => [0.1, 0.2, 0.3]);
          },
        },
        semanticIndex: {
          async refresh(records) {
            assert.equal(records.length, 1);
            assert.equal(records[0]?.title, "OpenAI releases new agent tooling");
            return {
              upsertedCount: records.length,
              deletedCount: 0,
            };
          },
          async search() {
            return [];
          },
          async isReady() {
            return true;
          },
        },
      },
    );

    const data = refresh.stdout.data as {
      itemsSelected: number;
      itemsIndexed: number;
      model: string;
    };
    assert.equal(refresh.exitCode, 0);
    assert.equal(data.itemsSelected, 1);
    assert.equal(data.itemsIndexed, 1);
    assert.equal(data.model, "fake-embedding-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorldItems supports semantic strategy against indexed world items", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-semantic-search-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Headlines</title>
          <item>
            <title>Conflict in Middle East rattles global markets</title>
            <link>https://example.com/global-markets</link>
            <guid>news-1</guid>
            <description>Oil jumps as conflict escalates.</description>
            <pubDate>2026-04-03T09:00:00.000Z</pubDate>
          </item>
        </channel>
      </rss>`;

    runtime.env.PIN_WORLD_HEADLINES_URL_TEMPLATE = `data:text/xml,${encodeURIComponent(feed)}`;

    const { fetchHeadlines } = await import("./service.js");
    await fetchHeadlines(runtime, {
      topic: "geopolitics",
      region: "global",
      limit: "10",
      provider: "google-news",
    });

    const { listWorldItems } = await import("./service.js");
    const listed = await listWorldItems(runtime, { limit: "10" });
    const itemId = ((listed.stdout.data as Array<{ id: string }>)?.[0]?.id) ?? "";
    assert.ok(itemId);

    const search = await searchWorldItems(
      runtime,
      {
        query: "oil markets war",
        strategy: "semantic",
        limit: 5,
      },
      {
        embeddingProvider: {
          model: "fake-embedding-model",
          async embedTexts(texts) {
            return texts.map(() => [0.1, 0.2, 0.3]);
          },
        },
        semanticIndex: {
          async refresh() {
            return { upsertedCount: 0, deletedCount: 0 };
          },
          async search() {
            return [
              {
                id: itemId,
                score: 0.91,
              },
            ];
          },
          async isReady() {
            return true;
          },
        },
      },
    );

    const data = search.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ matchReason: string; title: string }>;
    };
    assert.equal(search.exitCode, 0);
    assert.equal(data.strategy, "semantic");
    assert.equal(data.degraded, false);
    assert.equal(data.results[0]?.matchReason, "semantic");
    assert.equal(
      data.results[0]?.title,
      "Conflict in Middle East rattles global markets",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("searchWorldItems degrades to keyword when hybrid search embeddings fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-hybrid-fallback-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>News</title>
          <item>
            <title>OpenAI enterprise launch</title>
            <link>https://example.com/openai-enterprise</link>
            <guid>news-1</guid>
            <description>Enterprise release for AI workplace products.</description>
            <pubDate>2026-04-03T11:00:00.000Z</pubDate>
          </item>
        </channel>
      </rss>`;

    runtime.env.PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE = `data:text/xml,${encodeURIComponent(feed)}`;

    const { searchNews } = await import("./service.js");
    await searchNews(runtime, {
      query: "OpenAI enterprise",
      limit: "10",
      provider: "google-news",
    });

    const search = await searchWorldItems(
      runtime,
      {
        query: "enterprise",
        strategy: "hybrid",
        limit: 5,
      },
      {
        embeddingProvider: {
          model: "broken-model",
          async embedTexts() {
            throw new Error("invalid embedding key");
          },
        },
        semanticIndex: {
          async refresh() {
            return { upsertedCount: 0, deletedCount: 0 };
          },
          async search() {
            return [];
          },
          async isReady() {
            return true;
          },
        },
      },
    );

    const data = search.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ matchReason: string; title: string }>;
    };
    assert.equal(search.exitCode, 0);
    assert.equal(data.strategy, "keyword");
    assert.equal(data.degraded, true);
    assert.equal(data.results[0]?.title, "OpenAI enterprise launch");
    assert.equal(search.stdout._notice?.search?.message.includes("降级"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shortlistWorldItems ranks by profile interests and buildWorldContext returns compact view", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-shortlist-service-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root } as Record<string, string>,
      homeDir: "/Users/test",
    };

    const manager = new PinDatabaseManager(root);
    await manager.init();
    const profileRepository = new ProfileRepository(manager.open("pin"));
    await profileRepository.create({
      id: "default",
      displayName: "Alice",
    });
    await profileRepository.addSignal("default", {
      kind: "liked",
      targetType: "topic",
      targetKey: "ai",
      source: "explicit",
    });
    await profileRepository.addSignal("default", {
      kind: "disliked",
      targetType: "topic",
      targetKey: "celebrity-gossip",
      source: "explicit",
    });
    await profileRepository.rollupSignals("default");

    const feed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Headlines</title>
          <item>
            <title>OpenAI launches new agent toolkit</title>
            <link>https://example.com/openai-agents</link>
            <guid>news-1</guid>
            <description>New developer toolkit for agents.</description>
            <pubDate>2026-04-03T10:00:00.000Z</pubDate>
          </item>
          <item>
            <title>Celebrity couple announces new project</title>
            <link>https://example.com/celebrity-project</link>
            <guid>news-2</guid>
            <description>Entertainment news update.</description>
            <pubDate>2026-04-03T09:30:00.000Z</pubDate>
          </item>
        </channel>
      </rss>`;
    runtime.env.PIN_WORLD_HEADLINES_URL_TEMPLATE = `data:text/xml,${encodeURIComponent(feed)}`;

    await fetchHeadlines(runtime, {
      topic: "ai",
      region: "global",
      limit: "10",
      provider: "google-news",
    });
    await fetchHeadlines(runtime, {
      topic: "celebrity-gossip",
      region: "global",
      limit: "10",
      provider: "google-news",
    });

    const shortlist = await shortlistWorldItems(runtime, {
      profileId: "default",
      limit: "10",
    });

    const shortlistData = shortlist.stdout.data as Array<{
      id: string;
      title: string;
      profileScore: number;
      reasons: Array<{ code: string; value: string | number }>;
    }>;
    assert.equal(shortlist.exitCode, 0);
    assert.equal(shortlistData[0]?.title, "OpenAI launches new agent toolkit");
    assert.equal((shortlistData[0]?.profileScore ?? 0) > 0, true);
    assert.equal(
      shortlistData[0]?.reasons.some((reason) => reason.code === "TOPIC_MATCH"),
      true,
    );

    const context = await buildWorldContext(runtime, {
      ids: shortlistData[0]?.id ?? "",
    });
    const contextData = context.stdout.data as Array<{
      title: string;
      topics: string[];
      summary: string | null;
    }>;
    assert.equal(context.exitCode, 0);
    assert.equal(contextData[0]?.title, "OpenAI launches new agent toolkit");
    assert.equal(contextData[0]?.topics.includes("ai"), true);
    assert.equal(contextData[0]?.summary, "New developer toolkit for agents.");

    const simpleGet = await (await import("./service.js")).getWorldItem(
      runtime,
      shortlistData[0]?.id ?? "",
    );
    const simpleGetData = simpleGet.stdout.data as Record<string, unknown>;
    assert.equal("normalizedUrl" in simpleGetData, false);

    const fullGet = await (await import("./service.js")).getWorldItem(
      runtime,
      shortlistData[0]?.id ?? "",
      true,
    );
    const fullGetData = fullGet.stdout.data as Record<string, unknown>;
    assert.equal("normalizedUrl" in fullGetData, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
