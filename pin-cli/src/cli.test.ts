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
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord> };
    assert.equal(fetched.stdout.data?.metadata.source, "cli");

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
    )) as RunCliResult & { stdout: PinEnvelope<ProfileRecord[]> };
    assert.equal(listed.stdout.data?.length, 1);

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
