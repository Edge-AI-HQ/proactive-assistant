import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "./cli.js";
import type { PinEnvelope } from "./output/envelope.js";
import type { RunCliResult } from "./runtime.js";
import { runPersonalSync } from "./domains/personal/service.js";

interface SysDoctorData {
  checks: Array<{ name: string; status: string; message: string; hint?: string }>;
  ok: boolean;
  dataRoot: string;
  paths: {
    pin: string;
  };
}

interface ProfileRecord {
  id: string;
  displayName: string;
  locale: string | null;
  timezone: string | null;
  summary: string | null;
  facts?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  goals?: Array<Record<string, unknown>>;
  constraints?: Record<string, unknown>;
  memory?: Array<Record<string, unknown>>;
}

interface ProfileSimpleRecord {
  id: string;
  displayName: string;
  locale: string | null;
  timezone: string | null;
  summary: string | null;
}

interface ProfileInterestRecord {
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  status: string;
}

interface ProfileSnapshotRecord {
  profileId: string;
  view: string;
  topPositiveTopics: Array<{ key: string; score: number; evidenceCount: number; facts: Array<{ code: string; value: string | number }> }>;
  topNegativeTopics: Array<{ key: string; score: number; evidenceCount: number; facts: Array<{ code: string; value: string | number }> }>;
  topEntities: Array<{ key: string; score: number; evidenceCount: number; facts: Array<{ code: string; value: string | number }> }>;
  activeConstraints: Array<{ key: string; facts: Array<{ code: string; value: string }> }>;
}

interface WorldItemRecord {
  id: string;
  provider: string;
  streamType: string;
  title: string;
  url: string;
  normalizedUrl: string;
  searchQueries: string[];
  topics?: string[];
  regions?: string[];
  importance?: string | null;
}

interface WorldShortlistRecord {
  id: string;
  title: string;
  profileScore: number;
  reasons: Array<{ code: string; value: string | number }>;
}

interface WorldContextRecord {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  importance: string | null;
}

interface WorldSimpleRecord {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  importance: string | null;
  publishedAt?: string | null;
  provider?: string;
}

interface PersonalSourceRecord {
  id: string;
  userId: string;
  provider: string;
  toolkit: string;
  connectedAccountId: string;
  status: string;
  syncEnabled: boolean;
}

interface PersonalSyncStatusRecord {
  sourceId: string;
  userId: string;
  syncStrategy: string;
  lastSuccessAt: string | null;
  lastBackfillAt: string | null;
}

interface PersonalSyncStatusEnvelope {
  states: PersonalSyncStatusRecord[];
  recentRuns: Array<{
    sourceId: string | null;
    userId: string | null;
    status: string;
    fetchedCount: number;
    upsertedCount: number;
  }>;
}

interface PersonalSearchEnvelope {
  strategy: string;
  degraded: boolean;
  results: Array<{
    id: string;
    toolkit: string;
    title: string | null;
  }>;
}

test("runCli returns ok envelope for sys doctor json command", async () => {
  const result = await runCli(["sys", "doctor", "--json"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  assert.equal(result.stdout.meta.domain, "sys");
  assert.equal(result.stdout.meta.command, "doctor");
});

test("runCli returns invalid argument for unknown domain", async () => {
  const result = await runCli(["wat", "doctor", "--json"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.ok, false);
  assert.equal(result.stdout.error?.code, "INVALID_ARGUMENT");
  assert.equal(result.stdout.error?.type, "validation");
  assert.ok(result.stdout.error?.hint);
});

test("sys doctor reports checklist with database root", async () => {
  const result = await runCli(["sys", "doctor", "--json"], {
    env: { PIN_DATA_ROOT: "/tmp/pin-test-root" },
    homeDir: "/Users/test",
  });
  const stdout = result.stdout as PinEnvelope<SysDoctorData>;

  assert.equal(result.exitCode, 0);
  assert.equal(stdout.ok, true);
  assert.equal(stdout.data?.dataRoot, "/tmp/pin-test-root");
  assert.equal(stdout.data?.paths.pin.includes("pin.db"), true);
  assert.ok(Array.isArray(stdout.data?.checks));
  assert.ok(stdout.data?.checks.some((c) => c.name === "cli_version"));
  assert.ok(stdout.data?.checks.some((c) => c.name === "data_root"));
});

test("sys schema lists all registered commands", async () => {
  const result = await runCli(["sys", "schema", "--json"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  assert.equal(result.stdout.meta.domain, "sys");
  assert.equal(result.stdout.meta.command, "schema");
  const data = result.stdout.data as { commands: Array<{ path: string }> };
  assert.ok(data.commands.length > 0);
});

test("sys schema returns command detail for known path", async () => {
  const result = await runCli(["sys", "schema", "profile.get", "--json"]);

  assert.equal(result.exitCode, 0);
  const data = result.stdout.data as { domain: string; command: string; flags: unknown[] };
  assert.equal(data.domain, "profile");
  assert.equal(data.command, "get");
  assert.ok(Array.isArray(data.flags));
});

test("sys schema includes world semantic commands", async () => {
  const findResult = await runCli(["sys", "schema", "world.find", "--json"]);
  assert.equal(findResult.exitCode, 0);
  const findData = findResult.stdout.data as { domain: string; command: string };
  assert.equal(findData.domain, "world");
  assert.equal(findData.command, "find");

  const indexResult = await runCli(["sys", "schema", "world.index.refresh", "--json"]);
  assert.equal(indexResult.exitCode, 0);
  const indexData = indexResult.stdout.data as { domain: string; command: string };
  assert.equal(indexData.domain, "world");
  assert.equal(indexData.command, "index refresh");
});

test("sys schema includes implemented section commands and system placeholders", async () => {
  const commandsResult = (await runCli(["sys", "schema", "--json"])) as RunCliResult & {
    stdout: PinEnvelope<{ commands: Array<{ path: string }> }>;
  };
  const paths = new Set(commandsResult.stdout.data?.commands.map((command) => command.path) ?? []);
  assert.equal(paths.has("sys.migrate"), true);
  assert.equal(paths.has("sys.import"), true);
  assert.equal(paths.has("profile.facts.get"), true);
  assert.equal(paths.has("profile.memory.add"), true);
  assert.equal(paths.has("profile.goals.upsert"), true);

  const memoryAdd = await runCli(["sys", "schema", "profile.memory.add", "--json"]);
  assert.equal(memoryAdd.exitCode, 0);
  const memoryAddData = memoryAdd.stdout.data as { domain: string; command: string; flags: Array<{ name: string }> };
  assert.equal(memoryAddData.domain, "profile");
  assert.equal(memoryAddData.command, "memory add");
  assert.equal(memoryAddData.flags.some((flag) => flag.name === "kind"), true);

  const migrate = await runCli(["sys", "schema", "sys.migrate", "--json"]);
  assert.equal(migrate.exitCode, 0);
  const migrateData = migrate.stdout.data as { domain: string; command: string };
  assert.equal(migrateData.domain, "sys");
  assert.equal(migrateData.command, "migrate");
});

test("sys schema returns not found for unknown path", async () => {
  const result = await runCli(["sys", "schema", "unknown.cmd", "--json"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.error?.code, "NOT_FOUND");
});

test("profile commands support CRUD demo", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-cli-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    const created = (await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--locale",
        "en-US",
        "--timezone",
        "Asia/Shanghai",
        "--summary",
        "Demo profile",
        "--metadata",
        '{"source":"cli"}',
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };
    assert.equal(created.exitCode, 0);
    assert.equal(created.stdout.data?.displayName, "Alice");

    const fetched = (await runCli(
      ["profile", "get", "--id", "default", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileSimpleRecord> };
    assert.equal(fetched.stdout.data?.displayName, "Alice");
    assert.equal("metadata" in (fetched.stdout.data ?? {}), false);

    const fullFetched = (await runCli(
      ["profile", "get", "--id", "default", "--full", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };
    assert.equal(fullFetched.stdout.data?.metadata.source, "cli");

    const updated = (await runCli(
      [
        "profile",
        "update",
        "--id",
        "default",
        "--display-name",
        "Alice Updated",
        "--metadata",
        '{"source":"cli","stage":"updated"}',
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };
    assert.equal(updated.stdout.data?.displayName, "Alice Updated");

    const listed = (await runCli(
      ["profile", "list", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileSimpleRecord[]> };
    assert.equal(listed.stdout.data?.length, 1);
    assert.equal("metadata" in (listed.stdout.data?.[0] ?? {}), false);

    const fullListed = (await runCli(
      ["profile", "list", "--full", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord[]> };
    assert.equal(fullListed.stdout.data?.[0]?.metadata.source, "cli");

    const deleted = await runCli(
      ["profile", "delete", "--id", "default", "--json"],
      runtime,
    );
    assert.equal(deleted.exitCode, 0);

    const afterDelete = (await runCli(
      ["profile", "get", "--id", "default", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };
    assert.equal(afterDelete.exitCode, 1);
    assert.equal(afterDelete.stdout.error?.type, "not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile create returns conflict when id already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-dup-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runCli(
      ["profile", "create", "--id", "dup", "--display-name", "Alice", "--json"],
      runtime,
    );

    const duplicate = await runCli(
      [
        "profile",
        "create",
        "--id",
        "dup",
        "--display-name",
        "Alice Again",
        "--json",
      ],
      runtime,
    );

    assert.equal(duplicate.exitCode, 1);
    assert.equal(duplicate.stdout.ok, false);
    assert.equal(duplicate.stdout.error?.code, "CONFLICT");
    assert.equal(duplicate.stdout.error?.type, "conflict");
    assert.ok(duplicate.stdout.error?.hint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile create defaults to simple output and supports --full", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-create-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    const created = (await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--metadata",
        '{"source":"cli"}',
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileSimpleRecord> };

    assert.equal(created.exitCode, 0);
    assert.equal(created.stdout.data?.id, "default");
    assert.equal("metadata" in (created.stdout.data ?? {}), false);

    const createdFull = (await runCli(
      [
        "profile",
        "create",
        "--id",
        "full",
        "--display-name",
        "Bob",
        "--metadata",
        '{"source":"cli"}',
        "--full",
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };

    assert.equal(createdFull.exitCode, 0);
    assert.equal(createdFull.stdout.data?.metadata.source, "cli");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback commands return NOT_IMPLEMENTED with hints", async () => {
  const result = await runCli(["feedback", "list", "--since", "7d", "--json"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.ok, false);
  assert.equal(result.stdout.error?.type, "not_implemented");
  assert.equal(result.stdout.error?.code, "NOT_IMPLEMENTED");
  assert.equal(result.stdout.meta.domain, "feedback");
});

test("push commands return NOT_IMPLEMENTED with hints", async () => {
  const result = await runCli(["push", "history", "--limit", "10", "--json"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.ok, false);
  assert.equal(result.stdout.error?.type, "not_implemented");
  assert.equal(result.stdout.error?.code, "NOT_IMPLEMENTED");
  assert.equal(result.stdout.meta.domain, "push");
});

test("personal source list returns an empty list for a fresh data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-sources-"));

  try {
    const result = (await runCli(
      ["personal", "source", "list", "--json"],
      {
        env: { PIN_DATA_ROOT: root },
        homeDir: "/Users/test",
      },
    )) as RunCliResult & { stdout: PinEnvelope<PersonalSourceRecord[]> };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.ok, true);
    assert.equal(result.stdout.meta.domain, "personal");
    assert.equal(result.stdout.meta.command, "source list");
    assert.deepEqual(result.stdout.data, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal sync status returns an empty status list for a fresh data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-status-"));

  try {
    const result = (await runCli(
      ["personal", "sync", "status", "--json"],
      {
        env: { PIN_DATA_ROOT: root },
        homeDir: "/Users/test",
      },
    )) as RunCliResult & { stdout: PinEnvelope<PersonalSyncStatusEnvelope> };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.ok, true);
    assert.equal(result.stdout.meta.domain, "personal");
    assert.equal(result.stdout.meta.command, "sync status");
    assert.deepEqual(result.stdout.data?.states, []);
    assert.deepEqual(result.stdout.data?.recentRuns, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal sync run --all succeeds with no supported sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-sync-"));

  try {
    const result = (await runCli(
      ["personal", "sync", "run", "--all", "--json"],
      {
        env: { PIN_DATA_ROOT: root },
        homeDir: "/Users/test",
      },
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        mode: string;
        requested: string;
        sourcesDiscovered: number;
        sourcesSynced: number;
      }>;
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.ok, true);
    assert.equal(result.stdout.meta.domain, "personal");
    assert.equal(result.stdout.meta.command, "sync run");
    assert.equal(result.stdout.data?.requested, "all");
    assert.equal(result.stdout.data?.sourcesDiscovered, 0);
    assert.equal(result.stdout.data?.sourcesSynced, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal item get and search read synced items through CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-cli-items-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runPersonalSync(
      runtime,
      { all: true, mode: "incremental" },
      {
        provider: {
          async listConnectedSources() {
            return [
              {
                id: "src_gmail_main",
                userId: "user_123",
                provider: "composio",
                toolkit: "gmail",
                connectedAccountId: "ca_gmail_1",
                accountLabel: "Primary Gmail",
                status: "ACTIVE",
                syncEnabled: true,
                authMetadataJson: '{"userId":"user_123"}',
              },
            ];
          },
        },
        executor: {
          async execute(toolSlug) {
            if (toolSlug === "GMAIL_FETCH_EMAILS") {
              return {
                data: {
                  messages: [{ messageId: "msg_1", threadId: "thread_1" }],
                },
              };
            }

            if (toolSlug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") {
              return {
                data: {
                  messageId: "msg_1",
                  threadId: "thread_1",
                  subject: "Weekly review",
                  preview: {
                    body: "Your weekly review is ready.",
                  },
                  sender: "PIN Team <team@pin.ai>",
                  to: "Smile <smile@pin.ai>",
                  messageTimestamp: "2026-04-02T11:00:00.000Z",
                },
              };
            }

            throw new Error(`Unexpected tool slug ${toolSlug}`);
          },
        },
      },
    );

    const item = await runCli(
      [
        "personal",
        "item",
        "get",
        "--id",
        "src_gmail_main:email:msg_1",
        "--json",
      ],
      runtime,
    );
    const itemData = item.stdout.data as {
      title: string | null;
      toolkit: string;
      userId: string;
    };

    assert.equal(item.exitCode, 0);
    assert.equal(itemData.title, "Weekly review");
    assert.equal(itemData.toolkit, "gmail");
    assert.equal(itemData.userId, "user_123");

    const sources = (await runCli(
      ["personal", "source", "list", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<PersonalSourceRecord[]> };
    assert.equal(sources.stdout.data?.[0]?.userId, "user_123");

    const search = (await runCli(
      [
        "personal",
        "search",
        "--query",
        "weekly",
        "--strategy",
        "hybrid",
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<PersonalSearchEnvelope> };

    assert.equal(search.exitCode, 0);
    assert.equal(search.stdout.data?.strategy, "keyword");
    assert.equal(search.stdout.data?.degraded, true);
    assert.equal(search.stdout.data?.results.length, 1);
    assert.equal(search.stdout.data?.results[0]?.id, "src_gmail_main:email:msg_1");

    const timeline = (await runCli(
      [
        "personal",
        "timeline",
        "--from",
        "2026-04-02T00:00:00.000Z",
        "--to",
        "2026-04-03T00:00:00.000Z",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<Array<{ id: string; title: string | null }>>;
    };

    assert.equal(timeline.exitCode, 0);
    assert.equal(timeline.stdout.data?.length, 1);
    assert.equal(timeline.stdout.data?.[0]?.id, "src_gmail_main:email:msg_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("envelope includes _notice field (null when empty)", async () => {
  const result = await runCli(["sys", "doctor", "--json"]);
  assert.equal(result.stdout._notice, null);
});

test("world search ingests deduplicated news items and exposes list/get", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-cli-"));
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>News</title>
        <item>
          <title>AI startup raises funding</title>
          <link>https://example.com/story?utm_source=rss</link>
          <guid>story-1</guid>
          <description>Funding round details</description>
          <pubDate>2026-04-02T08:00:00.000Z</pubDate>
        </item>
        <item>
          <title>AI startup raises funding duplicate</title>
          <link>https://example.com/story</link>
          <guid>story-2</guid>
          <description>Duplicate via another source</description>
          <pubDate>2026-04-02T09:00:00.000Z</pubDate>
        </item>
        <item>
          <title>Robotics startup ships new product</title>
          <link>https://example.com/robotics</link>
          <guid>story-3</guid>
          <description>Robotics launch</description>
          <pubDate>2026-04-02T07:30:00.000Z</pubDate>
        </item>
      </channel>
    </rss>`;

  try {
    const runtime = {
      env: {
        PIN_DATA_ROOT: root,
        PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE: `data:text/xml,${encodeURIComponent(feed)}`,
      },
      homeDir: "/Users/test",
    };

    const searched = (await runCli(
      [
        "world",
        "search",
        "--query",
        "startup",
        "--limit",
        "10",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        query: string;
        items: WorldSimpleRecord[];
      }>;
    };

    assert.equal(searched.exitCode, 0);
    assert.equal(searched.stdout.data?.query, "startup");
    assert.equal(searched.stdout.data?.items.length, 2);
    assert.equal("searchQueries" in (searched.stdout.data?.items[0] ?? {}), false);

    const searchedFull = (await runCli(
      [
        "world",
        "search",
        "--query",
        "startup",
        "--limit",
        "10",
        "--full",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        query: string;
        items: WorldItemRecord[];
      }>;
    };
    assert.deepEqual(searchedFull.stdout.data?.items[0]?.searchQueries, ["startup"]);

    const listed = (await runCli(
      ["world", "list", "--limit", "10", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    assert.equal(listed.stdout.data?.length, 2);

    const itemId = listed.stdout.data?.[0]?.id;
    assert.ok(itemId);

    const fetched = (await runCli(
      ["world", "get", "--id", itemId!, "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord> };
    assert.equal(fetched.exitCode, 0);
    assert.equal(fetched.stdout.data?.id, itemId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("world list supports incremental queries by time and id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-incremental-cli-"));
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>News</title>
        <item>
          <title>AI startup raises funding</title>
          <link>https://example.com/story</link>
          <guid>story-1</guid>
          <description>Funding round details</description>
          <pubDate>2026-04-02T08:00:00.000Z</pubDate>
        </item>
        <item>
          <title>Robotics startup ships new product</title>
          <link>https://example.com/robotics</link>
          <guid>story-2</guid>
          <description>Robotics launch</description>
          <pubDate>2026-04-02T09:00:00.000Z</pubDate>
        </item>
      </channel>
    </rss>`;

  try {
    const runtime = {
      env: {
        PIN_DATA_ROOT: root,
        PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE: `data:text/xml,${encodeURIComponent(feed)}`,
      },
      homeDir: "/Users/test",
    };

    await runCli(
      ["world", "search", "--query", "startup", "--limit", "10", "--json"],
      runtime,
    );

    const sinceList = (await runCli(
      [
        "world",
        "list",
        "--since",
        "2026-04-02T08:30:00.000Z",
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    assert.equal(sinceList.stdout.data?.length, 1);
    assert.equal(sinceList.stdout.data?.[0]?.title, "Robotics startup ships new product");

    const baseList = (await runCli(
      ["world", "list", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    const firstId = baseList.stdout.data?.[0]?.id;
    assert.ok(firstId);

    const afterIdList = (await runCli(
      ["world", "list", "--after-id", firstId!, "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    assert.equal(afterIdList.stdout.data?.length, 1);
    assert.equal(afterIdList.stdout.data?.[0]?.title, "AI startup raises funding");

    const queryList = (await runCli(
      ["world", "list", "--query", "robotics", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    assert.equal(queryList.stdout.data?.length, 1);
    assert.equal(queryList.stdout.data?.[0]?.title, "Robotics startup ships new product");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("world headlines ingests non-keyword global news into the same store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-headlines-cli-"));
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Headlines</title>
        <item>
          <title>Conflict in Middle East rattles global markets</title>
          <link>https://example.com/global-markets</link>
          <guid>headline-1</guid>
          <description>Oil jumps as conflict escalates</description>
          <pubDate>2026-04-02T10:30:00.000Z</pubDate>
        </item>
      </channel>
    </rss>`;

  try {
    const runtime = {
      env: {
        PIN_DATA_ROOT: root,
        PIN_WORLD_HEADLINES_URL_TEMPLATE: `data:text/xml,${encodeURIComponent(feed)}`,
      },
      homeDir: "/Users/test",
    };

    const result = (await runCli(
      [
        "world",
        "headlines",
        "--topic",
        "geopolitics",
        "--region",
        "global",
        "--limit",
        "10",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        topic: string;
        region: string;
        items: WorldSimpleRecord[];
      }>;
    };

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.data?.topic, "geopolitics");
    assert.equal(result.stdout.data?.region, "global");
    assert.equal(result.stdout.data?.items.length, 1);
    assert.deepEqual(result.stdout.data?.items[0]?.topics, ["geopolitics"]);
    assert.equal(result.stdout.data?.items[0]?.importance, "high");
    assert.equal("streamType" in (result.stdout.data?.items[0] ?? {}), false);

    const resultFull = (await runCli(
      [
        "world",
        "headlines",
        "--topic",
        "geopolitics",
        "--region",
        "global",
        "--limit",
        "10",
        "--full",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        topic: string;
        region: string;
        items: WorldItemRecord[];
      }>;
    };
    assert.equal(resultFull.stdout.data?.items[0]?.streamType, "headline");
    assert.deepEqual(resultFull.stdout.data?.items[0]?.regions, ["global"]);

    const stored = (await runCli(
      ["world", "list", "--query", "markets", "--full", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldItemRecord[]> };
    assert.equal(stored.stdout.data?.length, 1);
    assert.equal(stored.stdout.data?.[0]?.streamType, "headline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("world search returns provider error envelope when fetch throws", async () => {
  const runtime = {
    env: {
      PIN_DATA_ROOT: "/tmp/pin-provider-error",
      PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE: "http://127.0.0.1:1/rss?q={query}",
    },
    homeDir: "/Users/test",
  };

  const result = await runCli(
    ["world", "search", "--query", "OpenAI", "--json"],
    runtime,
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.ok, false);
  assert.equal(result.stdout.error?.type, "provider_unavailable");
  assert.equal(result.stdout.error?.code, "PROVIDER_UNAVAILABLE");
  assert.equal(result.stdout.meta.domain, "world");
  assert.equal(result.stdout.meta.command, "search");
});

test("world shortlist uses profile interests and context returns compact items", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-world-shortlist-cli-"));
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Headlines</title>
        <item>
          <title>OpenAI launches new agent toolkit</title>
          <link>https://example.com/openai-agents</link>
          <guid>headline-1</guid>
          <description>New developer toolkit for agents.</description>
          <pubDate>2026-04-03T10:00:00.000Z</pubDate>
        </item>
        <item>
          <title>Celebrity couple announces new project</title>
          <link>https://example.com/celebrity-project</link>
          <guid>headline-2</guid>
          <description>Entertainment news update.</description>
          <pubDate>2026-04-03T09:30:00.000Z</pubDate>
        </item>
      </channel>
    </rss>`;

  try {
    const runtime = {
      env: {
        PIN_DATA_ROOT: root,
        PIN_WORLD_HEADLINES_URL_TEMPLATE: `data:text/xml,${encodeURIComponent(feed)}`,
      },
      homeDir: "/Users/test",
    };

    await runCli(
      ["profile", "create", "--id", "default", "--display-name", "Alice", "--json"],
      runtime,
    );
    await runCli(
      [
        "profile",
        "signal",
        "add",
        "--id",
        "default",
        "--kind",
        "liked",
        "--target-type",
        "topic",
        "--target-key",
        "ai",
        "--source",
        "explicit",
        "--json",
      ],
      runtime,
    );
    await runCli(
      [
        "profile",
        "signal",
        "add",
        "--id",
        "default",
        "--kind",
        "disliked",
        "--target-type",
        "topic",
        "--target-key",
        "celebrity-gossip",
        "--source",
        "explicit",
        "--json",
      ],
      runtime,
    );
    await runCli(
      ["profile", "signal", "rollup", "--id", "default", "--since", "30d", "--json"],
      runtime,
    );

    await runCli(
      [
        "world",
        "headlines",
        "--topic",
        "ai",
        "--region",
        "global",
        "--limit",
        "10",
        "--json",
      ],
      runtime,
    );

    await runCli(
      [
        "world",
        "headlines",
        "--topic",
        "celebrity-gossip",
        "--region",
        "global",
        "--limit",
        "10",
        "--json",
      ],
      runtime,
    );

    const shortlist = (await runCli(
      [
        "world",
        "shortlist",
        "--profile-id",
        "default",
        "--limit",
        "10",
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldShortlistRecord[]> };
    assert.equal(shortlist.exitCode, 0);
    assert.equal(shortlist.stdout.data?.[0]?.title, "OpenAI launches new agent toolkit");
    assert.equal((shortlist.stdout.data?.[0]?.profileScore ?? 0) > 0, true);
    assert.equal(shortlist.stdout.data?.[0]?.reasons.some((reason) => reason.code === "TOPIC_MATCH"), true);
    assert.equal(
      shortlist.stdout.data?.[0]?.reasons.some((reason) => reason.code === "SUPPRESSED_TOPIC_MATCH"),
      true,
    );
    assert.equal(
      shortlist.stdout.data?.some((item) => item.title === "Celebrity couple announces new project"),
      true,
    );

    const topId = shortlist.stdout.data?.[0]?.id;
    assert.ok(topId);

    const simpleGet = (await runCli(
      ["world", "get", "--id", topId!, "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldSimpleRecord> };
    assert.equal(simpleGet.exitCode, 0);
    assert.equal("normalizedUrl" in (simpleGet.stdout.data ?? {}), false);
    assert.equal(simpleGet.stdout.data?.title, "OpenAI launches new agent toolkit");

    const fullGet = (await runCli(
      ["world", "get", "--id", topId!, "--full", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<Record<string, unknown>> };
    assert.equal(fullGet.exitCode, 0);
    assert.equal("normalizedUrl" in (fullGet.stdout.data ?? {}), true);

    const context = (await runCli(
      [
        "world",
        "context",
        "--ids",
        topId!,
        "--json",
      ],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<WorldContextRecord[]> };
    assert.equal(context.exitCode, 0);
    assert.equal(context.stdout.data?.length, 1);
    assert.equal(context.stdout.data?.[0]?.title, "OpenAI launches new agent toolkit");
    assert.equal(context.stdout.data?.[0]?.topics.includes("ai"), true);
    assert.equal(context.stdout.data?.[0]?.summary, "New developer toolkit for agents.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile supports preferences goals and constraints sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-sections-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--json",
      ],
      runtime,
    );

    const preferenceSet = await runCli(
      [
        "profile",
        "preferences",
        "set",
        "--key",
        "content_topics",
        "--value-json",
        '["ai","startups"]',
        "--json",
      ],
      runtime,
    );
    assert.equal(preferenceSet.exitCode, 0);

    const preferenceGet = (await runCli(
      ["profile", "preferences", "get", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<Record<string, unknown>> };
    assert.deepEqual(preferenceGet.stdout.data?.content_topics, [
      "ai",
      "startups",
    ]);

    const goalUpsert = await runCli(
      [
        "profile",
        "goals",
        "upsert",
        "--key",
        "career",
        "--title",
        "Find startup opportunities",
        "--priority",
        "high",
        "--json",
      ],
      runtime,
    );
    assert.equal(goalUpsert.exitCode, 0);

    const goalList = (await runCli(
      ["profile", "goals", "list", "--json"],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<Array<Record<string, unknown>>>;
    };
    assert.equal(goalList.stdout.data?.length, 1);
    assert.equal(goalList.stdout.data?.[0]?.key, "career");

    const goalClose = await runCli(
      ["profile", "goals", "close", "--key", "career", "--json"],
      runtime,
    );
    assert.equal(goalClose.exitCode, 0);

    const constraintSet = await runCli(
      [
        "profile",
        "constraints",
        "set",
        "--key",
        "quiet_hours",
        "--value-json",
        '"23:00-08:00"',
        "--json",
      ],
      runtime,
    );
    assert.equal(constraintSet.exitCode, 0);

    const constraintGet = (await runCli(
      ["profile", "constraints", "get", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<Record<string, unknown>> };
    assert.equal(constraintGet.stdout.data?.quiet_hours, "23:00-08:00");

    const constraintUnset = await runCli(
      ["profile", "constraints", "unset", "--key", "quiet_hours", "--json"],
      runtime,
    );
    assert.equal(constraintUnset.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile supports facts section for stable background information", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-facts-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--json",
      ],
      runtime,
    );

    const factsSet = await runCli(
      [
        "profile",
        "facts",
        "set",
        "--key",
        "home_address",
        "--value-json",
        '"Shanghai Pudong"',
        "--json",
      ],
      runtime,
    );
    assert.equal(factsSet.exitCode, 0);

    await runCli(
      [
        "profile",
        "facts",
        "set",
        "--key",
        "work_location",
        "--value-json",
        '"Zhangjiang"',
        "--json",
      ],
      runtime,
    );

    const factsGet = (await runCli(
      ["profile", "facts", "get", "--json"],
      runtime,
    )) as RunCliResult & { stdout: PinEnvelope<Record<string, unknown>> };
    assert.equal(factsGet.stdout.data?.home_address, "Shanghai Pudong");
    assert.equal(factsGet.stdout.data?.work_location, "Zhangjiang");

    const factsUnset = await runCli(
      ["profile", "facts", "unset", "--key", "home_address", "--json"],
      runtime,
    );
    assert.equal(factsUnset.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile supports memory add list search and remove", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-memory-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--json",
      ],
      runtime,
    );

    const added = (await runCli(
      [
        "profile",
        "memory",
        "add",
        "--kind",
        "observation",
        "--text",
        "User often opens AI startup news",
        "--tags-json",
        '["ai","news"]',
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<Record<string, unknown>>;
    };
    assert.equal(added.exitCode, 0);
    assert.equal(added.stdout.data?.kind, "observation");

    const listed = (await runCli(
      ["profile", "memory", "list", "--json"],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<Array<Record<string, unknown>>>;
    };
    assert.equal(listed.stdout.data?.length, 1);

    const searched = (await runCli(
      ["profile", "memory", "search", "--query", "startup", "--json"],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<Array<Record<string, unknown>>>;
    };
    assert.equal(searched.stdout.data?.length, 1);

    const removed = await runCli(
      [
        "profile",
        "memory",
        "remove",
        "--id",
        String(added.stdout.data?.id),
        "--json",
      ],
      runtime,
    );
    assert.equal(removed.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile supports signal rollup into interests and ranking snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-profile-rollup-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    await runCli(
      [
        "profile",
        "create",
        "--id",
        "default",
        "--display-name",
        "Alice",
        "--json",
      ],
      runtime,
    );

    await runCli(
      [
        "profile",
        "constraints",
        "set",
        "--key",
        "quiet_hours",
        "--value-json",
        '"23:00-08:00"',
        "--json",
      ],
      runtime,
    );

    const liked = await runCli(
      [
        "profile",
        "signal",
        "add",
        "--id",
        "default",
        "--kind",
        "liked",
        "--target-type",
        "topic",
        "--target-key",
        "ai",
        "--source",
        "explicit",
        "--json",
      ],
      runtime,
    );
    assert.equal(liked.exitCode, 0);

    const disliked = await runCli(
      [
        "profile",
        "signal",
        "add",
        "--id",
        "default",
        "--kind",
        "disliked",
        "--target-type",
        "topic",
        "--target-key",
        "celebrity-gossip",
        "--source",
        "explicit",
        "--json",
      ],
      runtime,
    );
    assert.equal(disliked.exitCode, 0);

    const entitySignal = await runCli(
      [
        "profile",
        "signal",
        "add",
        "--id",
        "default",
        "--kind",
        "followed_up",
        "--target-type",
        "entity",
        "--target-key",
        "OpenAI",
        "--source",
        "implicit",
        "--json",
      ],
      runtime,
    );
    assert.equal(entitySignal.exitCode, 0);

    const rolledUp = await runCli(
      [
        "profile",
        "signal",
        "rollup",
        "--id",
        "default",
        "--since",
        "30d",
        "--json",
      ],
      runtime,
    );
    assert.equal(rolledUp.exitCode, 0);

    const topicInterests = (await runCli(
      [
        "profile",
        "interests",
        "list",
        "--id",
        "default",
        "--kind",
        "topic",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<ProfileInterestRecord[]>;
    };
    assert.equal(topicInterests.exitCode, 0);
    assert.equal(topicInterests.stdout.data?.[0]?.key, "ai");
    assert.equal(topicInterests.stdout.data?.[0]?.status, "active");
    assert.equal(topicInterests.stdout.data?.some((item) => item.key === "celebrity-gossip"), true);

    const snapshot = (await runCli(
      [
        "profile",
        "snapshot",
        "build",
        "--id",
        "default",
        "--view",
        "ranking",
        "--json",
      ],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<ProfileSnapshotRecord>;
    };
    assert.equal(snapshot.exitCode, 0);
    assert.equal(snapshot.stdout.data?.topPositiveTopics[0]?.key, "ai");
    assert.equal(snapshot.stdout.data?.topPositiveTopics[0]?.facts.some((fact) => fact.code === "INTEREST_SCORE"), true);
    assert.equal(snapshot.stdout.data?.topNegativeTopics[0]?.key, "celebrity-gossip");
    assert.equal(snapshot.stdout.data?.topEntities[0]?.key, "OpenAI");
    assert.equal(snapshot.stdout.data?.activeConstraints[0]?.key, "quiet_hours");
    assert.equal(snapshot.stdout.data?.activeConstraints[0]?.facts[0]?.code, "CONSTRAINT_ACTIVE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
