import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as core from "../core/index.js";
import { runCli } from "./cli.js";
import type { PinEnvelope } from "./output/envelope.js";
import type { RunCliResult } from "./runtime.js";
import {
  listConnections,
  searchTools,
  getToolSchema,
  execTool,
} from "./domains/personal/service.js";
import type { PersonalProvider } from "../core/domains/personal/provider.js";
import { LoopRepository } from "./domains/loop/repository.js";

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

interface PersonalConnectionRecord {
  id: string;
  toolkit: string;
  status: string;
  accountLabel: string | null;
}

interface PersonalToolRecord {
  slug: string;
  description: string | null;
  toolkit: string | null;
}

interface PersonalExecData {
  tool: string;
  data: unknown;
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
  assert.equal(paths.has("memory.entries.list"), true);
  assert.equal(paths.has("memory.context"), true);
  assert.equal(paths.has("ingest.run"), true);
  assert.equal(paths.has("context.incremental"), true);
  assert.equal(paths.has("loop.commit"), true);
  assert.equal(paths.has("loop.status"), true);
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

test("memory context returns resident and relevant recall from the independent memory domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-memory-cli-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: root,
    };

    await runCli(["profile", "create", "--id", "default", "--display-name", "User", "--full", "--json"], runtime);
    await core.memory.recordMemoryEvent(runtime, {
      profileId: "default",
      source: "chat",
      kind: "user_said",
      subjectType: "conversation",
      subjectKey: "chat",
      text: "User is handling Supabase issue triage this week.",
    });

    const manager = new core.PinDatabaseManager(root);
    await manager.init();
    const repository = new core.MemoryRepository(manager.open("pin"));
    await core.memory.consolidateMemoryEvents({
      profileId: "default",
      memoryRepository: repository,
    });

    const result = await runCli(["memory", "context", "--query", "Supabase issue", "--json"], runtime);
    assert.equal(result.exitCode, 0);
    const data = result.stdout.data as {
      residentMemories: Array<{ text: string }>;
      relevantMemories: Array<{ text: string }>;
    };

    assert.equal(data.residentMemories.length > 0, true);
    assert.equal(data.relevantMemories.some((entry) => entry.text.includes("Supabase issue triage")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory consolidation keeps a single entry per subject when newer evidence changes the text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-memory-dedupe-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: root,
    };

    await runCli(["profile", "create", "--id", "default", "--display-name", "User", "--full", "--json"], runtime);

    await core.memory.recordMemoryEvent(runtime, {
      profileId: "default",
      source: "dreaming",
      kind: "profile_refined",
      subjectType: "dreaming",
      subjectKey: "summary",
      text: "First summary",
      occurredAt: "2026-04-10T10:00:00.000Z",
    });
    await core.memory.recordMemoryEvent(runtime, {
      profileId: "default",
      source: "dreaming",
      kind: "profile_refined",
      subjectType: "dreaming",
      subjectKey: "summary",
      text: "Updated summary",
      occurredAt: "2026-04-10T11:00:00.000Z",
    });

    const manager = new core.PinDatabaseManager(root);
    await manager.init();
    const repository = new core.MemoryRepository(manager.open("pin"));
    await core.memory.consolidateMemoryEvents({
      profileId: "default",
      memoryRepository: repository,
    });

    const entries = await repository.listEntries("default", { category: "dreaming", limit: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, "Updated summary");
    assert.deepEqual(entries[0]?.sourceEventIds.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context incremental and loop commit support agent-style consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-context-cli-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };
    const manager = new PinDatabaseManager(root);
    await manager.init();
    const repository = new LoopRepository(manager.open("pin"));

    await repository.enqueuePending({
      items: [
        {
          id: "world:1",
          source: "world",
          kind: "headline",
          createdAt: "2026-04-08T10:00:00.000Z",
          availableAt: "2026-04-08T10:00:00.000Z",
          status: "pending",
          processedAt: null,
          payload: {
            id: "1",
            title: "Fed holds rates",
            provider: "fed",
          },
        },
      ],
    });

    const incremental = (await runCli(
      ["context", "incremental", "--json"],
      runtime,
    )) as RunCliResult & {
      stdout: PinEnvelope<{
        runToken: string;
        items: { world: Array<{ id: string; title: string }>; personal: unknown[] };
      }>;
    };

    assert.equal(incremental.exitCode, 0);
    assert.equal(incremental.stdout.data?.items.world.length, 1);
    const runToken = incremental.stdout.data?.runToken;
    assert.ok(runToken);

    const committed = await runCli(
      ["loop", "commit", "--run-token", runToken!, "--json"],
      runtime,
    );
    assert.equal(committed.exitCode, 0);
    assert.equal((committed.stdout.data as { processedCount: number }).processedCount, 1);

    const status = await runCli(
      ["loop", "status", "--json"],
      runtime,
    );
    assert.equal(status.exitCode, 0);
    assert.equal((status.stdout.data as { pendingCount: number }).pendingCount, 0);
    assert.equal((status.stdout.data as { processedCount: number }).processedCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("feedback log, list, get, stats full lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-feedback-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };

    // log a card_action confirm
    const logged = await runCli(
      ["feedback", "log", "--kind", "card_action", "--action", "confirm",
       "--basket", "work", "--channel", "telegram", "--source", "user_direct",
       "--intent-card-id", "ic_001", "--push-id", "push_123", "--json"],
      runtime,
    );
    assert.equal(logged.exitCode, 0);
    assert.equal(logged.stdout.ok, true);
    assert.equal(logged.stdout.meta.domain, "feedback");
    assert.equal(logged.stdout.meta.command, "log");
    const loggedData = logged.stdout.data as Record<string, unknown>;
    assert.equal(loggedData.kind, "card_action");
    assert.equal(loggedData.action, "confirm");
    assert.equal(loggedData.basket, "work");
    assert.equal(loggedData.intentCardId, "ic_001");
    const feedbackId = loggedData.id as string;
    assert.ok(feedbackId.startsWith("fe_"));

    // log a text_feedback
    const textLogged = await runCli(
      ["feedback", "log", "--kind", "text_feedback",
       "--text", "User prefers morning notifications",
       "--source", "user_derived", "--basket", "health",
       "--conversation-id", "conv_abc", "--message-id", "msg_456", "--json"],
      runtime,
    );
    assert.equal(textLogged.exitCode, 0);
    assert.equal(textLogged.stdout.ok, true);

    // log a card_open
    await runCli(
      ["feedback", "log", "--kind", "card_open", "--basket", "work", "--json"],
      runtime,
    );

    // get single event
    const got = await runCli(
      ["feedback", "get", "--id", feedbackId, "--json"],
      runtime,
    );
    assert.equal(got.exitCode, 0);
    assert.equal(got.stdout.ok, true);
    assert.equal((got.stdout.data as Record<string, unknown>).id, feedbackId);

    // get not found
    const notFound = await runCli(
      ["feedback", "get", "--id", "nonexistent", "--json"],
      runtime,
    );
    assert.equal(notFound.exitCode, 1);
    assert.equal(notFound.stdout.error?.code, "NOT_FOUND");

    // list all
    const listed = await runCli(
      ["feedback", "list", "--json"],
      runtime,
    );
    assert.equal(listed.exitCode, 0);
    assert.equal((listed.stdout.data as unknown[]).length, 3);

    // list filtered by basket
    const workOnly = await runCli(
      ["feedback", "list", "--basket", "work", "--json"],
      runtime,
    );
    assert.equal(workOnly.exitCode, 0);
    assert.equal((workOnly.stdout.data as unknown[]).length, 2);

    // list filtered by intent-card-id
    const icFiltered = await runCli(
      ["feedback", "list", "--intent-card-id", "ic_001", "--json"],
      runtime,
    );
    assert.equal(icFiltered.exitCode, 0);
    assert.equal((icFiltered.stdout.data as unknown[]).length, 1);

    // stats
    const stats = await runCli(
      ["feedback", "stats", "--json"],
      runtime,
    );
    assert.equal(stats.exitCode, 0);
    assert.equal(stats.stdout.ok, true);
    const statsData = stats.stdout.data as Record<string, unknown>;
    assert.equal(statsData.totalCount, 3);
    assert.equal(statsData.grossHitCount, 2); // card_action(confirm) + card_open
    assert.equal(statsData.qualifiedHitCount, 1); // card_action(confirm)
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback log with --dry-run does not persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-feedback-dry-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };

    const dryResult = await runCli(
      ["feedback", "log", "--kind", "card_action", "--action", "confirm",
       "--basket", "work", "--dry-run", "--json"],
      runtime,
    );
    assert.equal(dryResult.exitCode, 0);
    assert.equal(dryResult.stdout.ok, true);
    assert.equal((dryResult.stdout.data as Record<string, unknown>).dryRun, true);

    const listed = await runCli(
      ["feedback", "list", "--json"],
      runtime,
    );
    assert.equal((listed.stdout.data as unknown[]).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("feedback log validates kind enum", async () => {
  const result = await runCli(
    ["feedback", "log", "--kind", "invalid_kind", "--json"],
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.ok, false);
  assert.ok(result.stdout.error?.message.includes("Invalid"));
});

test("feedback log persists metadata json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-feedback-meta-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };

    const logged = await runCli(
      [
        "feedback",
        "log",
        "--kind",
        "card_action",
        "--action",
        "confirm",
        "--intent-card-id",
        "ic_101",
        "--metadata",
        "{\"runId\":\"run_123\",\"intentKey\":\"work:review-queue-with-alex\",\"surface\":\"now_feed\"}",
        "--json",
      ],
      runtime,
    );

    assert.equal(logged.exitCode, 0);
    assert.equal(logged.stdout.ok, true);
    const loggedData = logged.stdout.data as Record<string, unknown>;
    assert.deepEqual(loggedData.metadata, {
      runId: "run_123",
      intentKey: "work:review-queue-with-alex",
      surface: "now_feed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push record, get, history, outcome, find-similar full lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-push-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };

    // record a push
    const recorded = await runCli(
      ["push", "record", "--kind", "proactive_card", "--title", "AI funding roundup",
       "--basket", "work", "--channel", "telegram", "--ref", "article_set_77",
       "--reason", "matches user interest", "--intent-card-id", "ic_001", "--json"],
      runtime,
    );
    assert.equal(recorded.exitCode, 0);
    assert.equal(recorded.stdout.ok, true);
    assert.equal(recorded.stdout.meta.domain, "push");
    assert.equal(recorded.stdout.meta.command, "record");
    const recordData = recorded.stdout.data as Record<string, unknown>;
    assert.equal(recordData.kind, "proactive_card");
    assert.equal(recordData.title, "AI funding roundup");
    assert.equal(recordData.basket, "work");
    assert.equal(recordData.channel, "telegram");
    assert.equal(recordData.ref, "article_set_77");
    assert.equal(recordData.intentCardId, "ic_001");
    const pushId = recordData.id as string;
    assert.ok(pushId.startsWith("push_"));

    // record a second push (different kind)
    await runCli(
      ["push", "record", "--kind", "digest", "--title", "Weekly health digest",
       "--basket", "health", "--json"],
      runtime,
    );

    // get with outcomes (should be empty)
    const gotten = await runCli(
      ["push", "get", "--id", pushId, "--json"],
      runtime,
    );
    assert.equal(gotten.exitCode, 0);
    assert.equal(gotten.stdout.ok, true);
    const getdata = gotten.stdout.data as Record<string, unknown>;
    assert.equal(getdata.id, pushId);
    assert.deepEqual(getdata.outcomes, []);

    // record outcome
    const outcomeResult = await runCli(
      ["push", "outcome", "--id", pushId, "--status", "clicked", "--json"],
      runtime,
    );
    assert.equal(outcomeResult.exitCode, 0);
    assert.equal(outcomeResult.stdout.ok, true);
    const outcomeData = outcomeResult.stdout.data as Record<string, unknown>;
    assert.equal(outcomeData.pushId, pushId);
    assert.equal(outcomeData.status, "clicked");
    assert.ok((outcomeData.id as string).startsWith("po_"));

    // get again — outcomes should now contain 1 entry
    const gottenAgain = await runCli(
      ["push", "get", "--id", pushId, "--json"],
      runtime,
    );
    const getdata2 = gottenAgain.stdout.data as Record<string, unknown>;
    const outcomes = getdata2.outcomes as Array<Record<string, unknown>>;
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "clicked");

    // history — all
    const allHistory = await runCli(
      ["push", "history", "--json"],
      runtime,
    );
    assert.equal(allHistory.exitCode, 0);
    const allItems = allHistory.stdout.data as Array<Record<string, unknown>>;
    assert.equal(allItems.length, 2);

    // history — filter by kind
    const filteredHistory = await runCli(
      ["push", "history", "--kind", "digest", "--json"],
      runtime,
    );
    const filteredItems = filteredHistory.stdout.data as Array<Record<string, unknown>>;
    assert.equal(filteredItems.length, 1);
    assert.equal(filteredItems[0].kind, "digest");

    // history — filter by basket
    const basketHistory = await runCli(
      ["push", "history", "--basket", "work", "--json"],
      runtime,
    );
    const basketItems = basketHistory.stdout.data as Array<Record<string, unknown>>;
    assert.equal(basketItems.length, 1);
    assert.equal(basketItems[0].basket, "work");

    // find-similar — by ref
    const similar = await runCli(
      ["push", "find-similar", "--kind", "proactive_card", "--ref", "article_set_77", "--json"],
      runtime,
    );
    assert.equal(similar.exitCode, 0);
    const similarItems = similar.stdout.data as Array<Record<string, unknown>>;
    assert.equal(similarItems.length, 1);
    assert.equal(similarItems[0].id, pushId);

    // find-similar — by title keyword
    const titleSimilar = await runCli(
      ["push", "find-similar", "--kind", "proactive_card", "--title", "funding", "--json"],
      runtime,
    );
    const titleItems = titleSimilar.stdout.data as Array<Record<string, unknown>>;
    assert.equal(titleItems.length, 1);

    // find-similar — no match
    const noMatch = await runCli(
      ["push", "find-similar", "--kind", "proactive_card", "--title", "zzz_nonexistent", "--json"],
      runtime,
    );
    const noMatchItems = noMatch.stdout.data as Array<Record<string, unknown>>;
    assert.equal(noMatchItems.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push record dry-run does not persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-push-dry-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };

    const dryResult = await runCli(
      ["push", "record", "--kind", "notification", "--title", "Test", "--dry-run", "--json"],
      runtime,
    );
    assert.equal(dryResult.exitCode, 0);
    assert.equal(dryResult.stdout.ok, true);
    const dryData = dryResult.stdout.data as Record<string, unknown>;
    assert.equal(dryData.dryRun, true);
    assert.equal(dryData.operation, "INSERT");

    // history should be empty
    const history = await runCli(["push", "history", "--json"], runtime);
    const items = history.stdout.data as Array<Record<string, unknown>>;
    assert.equal(items.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push get NOT_FOUND for missing id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-push-nf-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };
    const result = await runCli(["push", "get", "--id", "push_nonexistent", "--json"], runtime);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.ok, false);
    assert.equal(result.stdout.error?.type, "not_found");
    assert.equal(result.stdout.error?.code, "NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push outcome NOT_FOUND for missing push id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-push-onf-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };
    const result = await runCli(
      ["push", "outcome", "--id", "push_nonexistent", "--status", "clicked", "--json"],
      runtime,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.ok, false);
    assert.equal(result.stdout.error?.type, "not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("push record validates kind enum", async () => {
  const result = await runCli(
    ["push", "record", "--kind", "invalid_kind", "--title", "Test", "--json"],
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.ok, false);
  assert.ok(result.stdout.error?.message.includes("Invalid"));
});

test("push outcome validates status enum", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-push-ve-"));
  try {
    const runtime = { env: { PIN_DATA_ROOT: root } };
    // First create a valid push
    const recorded = await runCli(
      ["push", "record", "--kind", "notification", "--title", "Test", "--json"],
      runtime,
    );
    const pushId = (recorded.stdout.data as Record<string, unknown>).id as string;

    const result = await runCli(
      ["push", "outcome", "--id", pushId, "--status", "invalid_status", "--json"],
      runtime,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout.ok, false);
    assert.ok(result.stdout.error?.message.includes("Invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal connections list returns empty with no API key", async () => {
  const runtime = {
    env: {},
    homeDir: "/Users/test",
  };

  const result = (await runCli(
    ["personal", "connections", "list", "--json"],
    runtime,
  )) as RunCliResult & { stdout: PinEnvelope<PersonalConnectionRecord[]> };

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  assert.equal(result.stdout.meta.domain, "personal");
  assert.equal(result.stdout.meta.command, "connections list");
  assert.deepEqual(result.stdout.data, []);
});

test("personal status reports platform mode when COMPOSIO_API_KEY is configured", async () => {
  const result = await runCli(
    ["personal", "status", "--json"],
    {
      env: { COMPOSIO_API_KEY: "ak_platform_test" },
      homeDir: "/Users/test",
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  const data = result.stdout.data as { configured: boolean; mode: string; source: string; keyPrefix: string | null };
  assert.equal(data.configured, true);
  assert.equal(data.mode, "platform");
  assert.equal(data.source, "platform-env");
  assert.equal(data.keyPrefix, "ak_pla...");
});

test("personal connections list returns mock connections via provider override", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };
  const noopConn = { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null };
  const mockProvider: PersonalProvider = {
    async discoverConnections() {
      return [
        { ...noopConn, toolkit: "gmail", connectedAccountId: "ca_1" },
        { ...noopConn, toolkit: "slack", connectedAccountId: "ca_2" },
      ];
    },
    async checkConnections() { return []; },
    async connectApp() { return noopConn; },
    async waitForConnection() { return noopConn; },
    async searchTools() { return []; },
    async getToolSchema() { return null; },
    async executeTool() { return { tool: "", success: false, data: null, error: "not called" }; },
    async disconnectAccount() {},
    async resolveAccountIdentity() { return null; },
  };

  const result = await listConnections(runtime, undefined, { provider: mockProvider });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  const data = result.stdout.data as PersonalConnectionRecord[];
  assert.equal(data.length, 2);
  assert.equal(data[0]?.toolkit, "gmail");
  assert.equal(data[1]?.toolkit, "slack");
});

test("personal tools search returns provider unavailable without API key", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };

  const result = await runCli(
    ["personal", "tools", "search", "--query", "gmail", "--json"],
    runtime,
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.ok, false);
  assert.equal(result.stdout.error?.type, "provider_unavailable");
  assert.equal(result.stdout.error?.code, "PROVIDER_NOT_CONFIGURED");
  assert.equal(result.stdout.meta.domain, "personal");
});

test("personal tools search returns results via provider override", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };
  const mockProvider: PersonalProvider = {
    async discoverConnections() { return []; },
    async checkConnections() { return []; },
    async connectApp() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async waitForConnection() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async searchTools(query) {
      return [
        { slug: "GMAIL_FETCH_EMAILS", description: "Fetch emails", toolkit: "gmail" },
        { slug: "GMAIL_SEND_EMAIL", description: "Send email", toolkit: "gmail" },
      ];
    },
    async getToolSchema() { return null; },
    async executeTool() { return { tool: "", success: false, data: null, error: "not called" }; },
    async disconnectAccount() {},
    async resolveAccountIdentity() { return null; },
  };

  const result = await searchTools(runtime, { query: "gmail" }, { provider: mockProvider });

  assert.equal(result.exitCode, 0);
  const data = result.stdout.data as { query: string; count: number; tools: PersonalToolRecord[] };
  assert.equal(data.query, "gmail");
  assert.equal(data.count, 2);
  assert.equal(data.tools[0]?.slug, "GMAIL_FETCH_EMAILS");
});

test("personal tools schema returns not found for unknown tool", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };
  const mockProvider: PersonalProvider = {
    async discoverConnections() { return []; },
    async checkConnections() { return []; },
    async connectApp() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async waitForConnection() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async searchTools() { return []; },
    async getToolSchema() { return null; },
    async executeTool() { return { tool: "", success: false, data: null, error: "not called" }; },
    async disconnectAccount() {},
    async resolveAccountIdentity() { return null; },
  };

  const result = await getToolSchema(runtime, { name: "NONEXISTENT_TOOL" }, { provider: mockProvider });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.error?.code, "TOOL_NOT_FOUND");
});

test("personal exec returns validation error for invalid JSON input", async () => {
  const result = await runCli(
    ["personal", "exec", "--tool", "GMAIL_FETCH_EMAILS", "--input", "not-json", "--json"],
    { env: { COMPOSIO_API_KEY: "ak_fake" }, homeDir: "/tmp" },
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout.error?.type, "validation");
  assert.equal(result.stdout.error?.code, "INVALID_ARGUMENT");
});

test("personal exec succeeds via provider override", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };
  const mockProvider: PersonalProvider = {
    async discoverConnections() { return []; },
    async checkConnections() { return []; },
    async connectApp() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async waitForConnection() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async searchTools() { return []; },
    async getToolSchema() { return null; },
    async executeTool(slug, args) {
      return {
        tool: slug,
        success: true,
        data: { emails: [{ subject: "Hello", from: "test@example.com" }] },
        error: null,
      };
    },
    async disconnectAccount() {},
    async resolveAccountIdentity() { return null; },
  };

  const result = await execTool(
    runtime,
    { tool: "GMAIL_FETCH_EMAILS", input: '{"max_results":5}' },
    { provider: mockProvider },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.ok, true);
  const data = result.stdout.data as PersonalExecData;
  assert.equal(data.tool, "GMAIL_FETCH_EMAILS");
  assert.ok(data.data);
});

test("personal exec returns error envelope when tool execution fails", async () => {
  const runtime = { env: {}, homeDir: "/tmp" };
  const mockProvider: PersonalProvider = {
    async discoverConnections() { return []; },
    async checkConnections() { return []; },
    async connectApp() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async waitForConnection() { return { toolkit: "", status: "ACTIVE", connectedAccountId: null, userInfo: null, redirectUrl: null }; },
    async searchTools() { return []; },
    async getToolSchema() { return null; },
    async executeTool(slug) {
      return {
        tool: slug,
        success: false,
        data: null,
        error: "Rate limit exceeded",
      };
    },
    async disconnectAccount() {},
    async resolveAccountIdentity() { return null; },
  };

  const result = await execTool(
    runtime,
    { tool: "GMAIL_FETCH_EMAILS" },
    { provider: mockProvider },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.error?.code, "TOOL_EXECUTION_FAILED");
  assert.ok(result.stdout.error?.message.includes("Rate limit"));
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
