import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getPersonalItem,
  listPersonalSources,
  listPersonalSyncStatus,
  runPersonalSync,
  searchPersonalItems,
  timelinePersonalItems,
} from "./service.js";
import type { PinEnvelope } from "../../output/envelope.js";

test("runPersonalSync discovers provider sources and persists them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-service-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    const syncResult = await runPersonalSync(
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
                scopesJson: '["gmail.readonly"]',
                authMetadataJson: '{"kind":"oauth2"}',
                lastSeenAt: "2026-04-02T12:00:00.000Z",
              },
            ];
          },
        },
      },
    );

    assert.equal(syncResult.exitCode, 0);
    assert.equal(syncResult.stdout.ok, true);
    assert.equal(
      (syncResult.stdout.data as { sourcesDiscovered: number }).sourcesDiscovered,
      1,
    );
    assert.equal(
      (syncResult.stdout.data as { sourcesSynced: number }).sourcesSynced,
      1,
    );

    const listed = (await listPersonalSources(runtime)) as {
      stdout: PinEnvelope<
        Array<{
          id: string;
          userId: string;
          toolkit: string;
          connectedAccountId: string;
          status: string;
          syncEnabled: boolean;
        }>
      >;
    };

    assert.equal(listed.stdout.data?.length, 1);
    assert.equal(listed.stdout.data?.[0]?.id, "src_gmail_main");
    assert.equal(listed.stdout.data?.[0]?.userId, "user_123");
    assert.equal(listed.stdout.data?.[0]?.toolkit, "gmail");
    assert.equal(listed.stdout.data?.[0]?.connectedAccountId, "ca_gmail_1");
    assert.equal(listed.stdout.data?.[0]?.status, "ACTIVE");
    assert.equal(listed.stdout.data?.[0]?.syncEnabled, true);

    const status = await listPersonalSyncStatus(runtime);
    const statusRows = (
      status.stdout.data as {
        states: Array<{
          sourceId: string;
          userId: string;
          syncStrategy: string;
          lastSuccessAt: string | null;
          lastBackfillAt: string | null;
        }>;
        recentRuns: Array<{
          sourceId: string | null;
          userId: string | null;
          status: string;
          fetchedCount: number;
        }>;
      }
    );
    assert.equal(statusRows.states.length, 1);
    assert.equal(statusRows.states[0]?.sourceId, "src_gmail_main");
    assert.equal(statusRows.states[0]?.userId, "user_123");
    assert.equal(statusRows.states[0]?.syncStrategy, "polling");
    assert.equal(typeof statusRows.states[0]?.lastSuccessAt, "string");
    assert.equal(statusRows.states[0]?.lastBackfillAt, null);
    assert.equal(statusRows.recentRuns.length, 1);
    assert.equal(statusRows.recentRuns[0]?.sourceId, "src_gmail_main");
    assert.equal(statusRows.recentRuns[0]?.userId, "user_123");
    assert.equal(statusRows.recentRuns[0]?.status, "success");
    assert.equal(statusRows.recentRuns[0]?.fetchedCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPersonalSync stores normalized gmail messages and getPersonalItem returns them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-gmail-sync-"));

  try {
    const runtime = {
      env: { PIN_DATA_ROOT: root },
      homeDir: "/Users/test",
    };

    const syncResult = await runPersonalSync(
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
          async execute(toolSlug, input) {
            if (toolSlug === "GMAIL_FETCH_EMAILS") {
              assert.equal(input.connectedAccountId, "ca_gmail_1");
              assert.equal(input.userId, "user_123");
              return {
                data: {
                  messages: [
                    { messageId: "msg_1", threadId: "thread_1" },
                  ],
                },
              };
            }

            if (toolSlug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") {
              assert.equal(input.connectedAccountId, "ca_gmail_1");
              assert.equal(input.userId, "user_123");
              return {
                data: {
                  messageId: "msg_1",
                  threadId: "thread_1",
                  subject: "Welcome to PIN",
                  preview: {
                    body: "Here is your onboarding summary.",
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

    assert.equal(syncResult.exitCode, 0);
    assert.equal(syncResult.stdout.ok, true);

    const item = await getPersonalItem(runtime, "src_gmail_main:email:msg_1");
    const data = item.stdout.data as {
      id: string;
      sourceId: string;
      userId: string;
      toolkit: string;
      itemType: string;
      externalId: string;
      occurredAt: string | null;
      title: string | null;
      contentText: string | null;
      attributes: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };

    assert.equal(item.exitCode, 0);
    assert.equal(data.id, "src_gmail_main:email:msg_1");
    assert.equal(data.sourceId, "src_gmail_main");
    assert.equal(data.userId, "user_123");
    assert.equal(data.toolkit, "gmail");
    assert.equal(data.itemType, "email");
    assert.equal(data.externalId, "msg_1");
    assert.equal(data.occurredAt, "2026-04-02T11:00:00.000Z");
    assert.equal(data.title, "Welcome to PIN");
    assert.equal(data.contentText, "Here is your onboarding summary.");
    assert.equal(data.attributes.sender, "PIN Team <team@pin.ai>");
    assert.equal(data.attributes.to, "Smile <smile@pin.ai>");

    const search = await searchPersonalItems(runtime, {
      query: "onboarding",
      strategy: "hybrid",
      facet: "sender=PIN Team <team@pin.ai>",
      limit: 5,
    });
    const searchData = search.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ id: string; title: string | null }>;
    };
    assert.equal(search.exitCode, 0);
    assert.equal(searchData.strategy, "keyword");
    assert.equal(searchData.degraded, true);
    assert.equal(searchData.results.length, 1);
    assert.equal(searchData.results[0]?.id, "src_gmail_main:email:msg_1");

    const timeline = await timelinePersonalItems(runtime, {
      from: "2026-04-02T00:00:00.000Z",
      to: "2026-04-03T00:00:00.000Z",
      toolkit: "gmail",
      limit: 5,
    });
    const timelineData = timeline.stdout.data as Array<{
      id: string;
      toolkit: string;
    }>;
    assert.equal(timeline.exitCode, 0);
    assert.equal(timelineData.length, 1);
    assert.equal(timelineData[0]?.id, "src_gmail_main:email:msg_1");
    assert.equal(timelineData[0]?.toolkit, "gmail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPersonalSync keeps userId on skipped sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-skip-user-"));

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
                id: "src_outlook_main",
                userId: "user_456",
                provider: "composio",
                toolkit: "outlook",
                connectedAccountId: "ca_outlook_1",
                accountLabel: "Primary Outlook",
                status: "EXPIRED",
                syncEnabled: false,
                authMetadataJson: '{"userId":"user_456"}',
              },
            ];
          },
        },
      },
    );

    const status = await listPersonalSyncStatus(runtime);
    const data = status.stdout.data as {
      states: Array<{ sourceId: string; userId: string }>;
      recentRuns: Array<{
        sourceId: string | null;
        userId: string | null;
        status: string;
      }>;
    };

    assert.equal(data.states[0]?.sourceId, "src_outlook_main");
    assert.equal(data.states[0]?.userId, "user_456");
    assert.equal(data.recentRuns[0]?.sourceId, "src_outlook_main");
    assert.equal(data.recentRuns[0]?.userId, "user_456");
    assert.equal(data.recentRuns[0]?.status, "skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
