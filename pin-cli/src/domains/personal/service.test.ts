import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getPersonalItem,
  listPersonalSources,
  listPersonalSyncStatus,
  runPersonalIndexRefresh,
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

test("runPersonalSync stores normalized google calendar events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-calendar-sync-"));

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
                id: "src_googlecalendar_main",
                userId: "user_789",
                provider: "composio",
                toolkit: "googlecalendar",
                connectedAccountId: "ca_calendar_1",
                accountLabel: "Primary Calendar",
                status: "ACTIVE",
                syncEnabled: true,
                authMetadataJson: '{"userId":"user_789"}',
              },
            ];
          },
        },
        executor: {
          async execute(toolSlug, input) {
            assert.equal(input.connectedAccountId, "ca_calendar_1");
            assert.equal(input.userId, "user_789");

            if (toolSlug === "GOOGLECALENDAR_LIST_CALENDARS") {
              return {
                data: {
                  items: [
                    {
                      id: "primary",
                      summary: "Personal",
                      timeZone: "Asia/Shanghai",
                    },
                  ],
                },
              };
            }

            if (toolSlug === "GOOGLECALENDAR_EVENTS_LIST") {
              return {
                data: {
                  items: [
                    {
                      id: "event_1",
                      recurringEventId: "series_1",
                      summary: "Dinner with team",
                      description: "Discuss personal feed next steps.",
                      htmlLink: "https://calendar.google.com/event?eid=event_1",
                      status: "confirmed",
                      organizer: {
                        email: "smile@pin.ai",
                      },
                      attendees: [
                        { email: "smile@pin.ai" },
                        { email: "team@pin.ai" },
                      ],
                      start: {
                        dateTime: "2026-04-02T19:00:00+08:00",
                      },
                      end: {
                        dateTime: "2026-04-02T20:00:00+08:00",
                      },
                    },
                  ],
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

    const item = await getPersonalItem(
      runtime,
      "src_googlecalendar_main:calendar_event:primary:event_1",
    );
    const data = item.stdout.data as {
      id: string;
      sourceId: string;
      userId: string;
      toolkit: string;
      itemType: string;
      externalId: string;
      externalParentId: string | null;
      occurredAt: string | null;
      title: string | null;
      contentText: string | null;
      url: string | null;
      attributes: Record<string, unknown>;
    };

    assert.equal(item.exitCode, 0);
    assert.equal(data.id, "src_googlecalendar_main:calendar_event:primary:event_1");
    assert.equal(data.sourceId, "src_googlecalendar_main");
    assert.equal(data.userId, "user_789");
    assert.equal(data.toolkit, "googlecalendar");
    assert.equal(data.itemType, "calendar_event");
    assert.equal(data.externalId, "primary:event_1");
    assert.equal(data.externalParentId, "series_1");
    assert.equal(data.occurredAt, "2026-04-02T19:00:00+08:00");
    assert.equal(data.title, "Dinner with team");
    assert.equal(data.contentText, "Discuss personal feed next steps.");
    assert.equal(
      data.url,
      "https://calendar.google.com/event?eid=event_1",
    );
    assert.equal(data.attributes.calendarId, "primary");
    assert.equal(data.attributes.calendarSummary, "Personal");
    assert.equal(data.attributes.organizerEmail, "smile@pin.ai");
    assert.equal(data.attributes.attendeesCount, 2);

    const timeline = await timelinePersonalItems(runtime, {
      from: "2026-04-02T00:00:00.000Z",
      to: "2026-04-03T00:00:00.000Z",
      toolkit: "googlecalendar",
      limit: 5,
    });
    const timelineData = timeline.stdout.data as Array<{
      id: string;
      toolkit: string;
    }>;
    assert.equal(timeline.exitCode, 0);
    assert.equal(timelineData.length, 1);
    assert.equal(
      timelineData[0]?.id,
      "src_googlecalendar_main:calendar_event:primary:event_1",
    );
    assert.equal(timelineData[0]?.toolkit, "googlecalendar");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPersonalSync stores normalized notion pages and databases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-notion-sync-"));

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
                id: "src_notion_main",
                userId: "user_999",
                provider: "composio",
                toolkit: "notion",
                connectedAccountId: "ca_notion_1",
                accountLabel: "Personal Notion",
                status: "ACTIVE",
                syncEnabled: true,
                authMetadataJson: '{"userId":"user_999"}',
              },
            ];
          },
        },
        executor: {
          async execute(toolSlug, input) {
            assert.equal(input.connectedAccountId, "ca_notion_1");
            assert.equal(input.userId, "user_999");

            if (toolSlug === "NOTION_FETCH_DATA") {
              return {
                data: {
                  results: [
                    {
                      object: "page",
                      id: "page_1",
                      url: "https://www.notion.so/page-1",
                      last_edited_time: "2026-04-02T10:30:00.000Z",
                      properties: {
                        Name: {
                          type: "title",
                          title: [{ plain_text: "Research Notes" }],
                        },
                      },
                      parent: {
                        type: "database_id",
                        database_id: "db_parent",
                      },
                    },
                    {
                      object: "database",
                      id: "db_1",
                      url: "https://www.notion.so/db-1",
                      last_edited_time: "2026-04-02T11:00:00.000Z",
                      title: [{ plain_text: "Personal Tasks" }],
                    },
                  ],
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

    const pageItem = await getPersonalItem(
      runtime,
      "src_notion_main:notion_page:page_1",
    );
    const pageData = pageItem.stdout.data as {
      id: string;
      userId: string;
      toolkit: string;
      itemType: string;
      externalParentId: string | null;
      title: string | null;
      occurredAt: string | null;
      url: string | null;
      attributes: Record<string, unknown>;
    };

    assert.equal(pageItem.exitCode, 0);
    assert.equal(pageData.id, "src_notion_main:notion_page:page_1");
    assert.equal(pageData.userId, "user_999");
    assert.equal(pageData.toolkit, "notion");
    assert.equal(pageData.itemType, "notion_page");
    assert.equal(pageData.externalParentId, "db_parent");
    assert.equal(pageData.title, "Research Notes");
    assert.equal(pageData.occurredAt, "2026-04-02T10:30:00.000Z");
    assert.equal(pageData.url, "https://www.notion.so/page-1");
    assert.equal(pageData.attributes.object, "page");

    const search = await searchPersonalItems(runtime, {
      query: "Research",
      strategy: "keyword",
      toolkit: "notion",
      limit: 5,
    });
    const searchData = search.stdout.data as {
      results: Array<{ id: string; title: string | null }>;
    };
    assert.equal(search.exitCode, 0);
    assert.equal(searchData.results.length, 1);
    assert.equal(searchData.results[0]?.id, "src_notion_main:notion_page:page_1");
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

test("runPersonalIndexRefresh indexes pending items and semantic search uses the semantic index", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-semantic-"));
  const indexedIds: string[] = [];

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
                  subject: "Career update",
                  preview: {
                    body: "You are actively exploring research directions.",
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

    const refresh = await runPersonalIndexRefresh(
      runtime,
      { pending: true },
      {
        embeddingProvider: {
          model: "fake-embedding-model",
          async embedTexts(texts) {
            return texts.map(() => [0.1, 0.2, 0.3]);
          },
        },
        semanticIndex: {
          async refresh(records) {
            indexedIds.push(...records.map((record) => record.id));
            return {
              upsertedCount: records.length,
              deletedCount: 0,
            };
          },
          async search() {
            return [
              {
                id: "src_gmail_main:email:msg_1",
                score: 0.92,
              },
            ];
          },
          async isReady() {
            return true;
          },
        },
      },
    );

    const refreshData = refresh.stdout.data as {
      mode: string;
      itemsSelected: number;
      itemsIndexed: number;
      deletedCount: number;
    };
    assert.equal(refresh.exitCode, 0);
    assert.equal(refreshData.mode, "pending");
    assert.equal(refreshData.itemsSelected, 1);
    assert.equal(refreshData.itemsIndexed, 1);
    assert.equal(indexedIds[0], "src_gmail_main:email:msg_1");

    const semantic = await searchPersonalItems(
      runtime,
      {
        query: "research direction",
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
                id: "src_gmail_main:email:msg_1",
                score: 0.92,
              },
            ];
          },
          async isReady() {
            return true;
          },
        },
      },
    );

    const semanticData = semantic.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ id: string; matchReason: string; userId: string }>;
    };
    assert.equal(semantic.exitCode, 0);
    assert.equal(semanticData.strategy, "semantic");
    assert.equal(semanticData.degraded, false);
    assert.equal(semanticData.results[0]?.id, "src_gmail_main:email:msg_1");
    assert.equal(semanticData.results[0]?.matchReason, "semantic");
    assert.equal(semanticData.results[0]?.userId, "user_123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid search falls back to keyword when semantic index is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-hybrid-fallback-"));

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

    const hybrid = await searchPersonalItems(
      runtime,
      {
        query: "weekly",
        strategy: "hybrid",
        limit: 5,
      },
      {
        embeddingProvider: {
          model: "fake-embedding-model",
          async embedTexts() {
            throw new Error("should not be called");
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
            return false;
          },
        },
      },
    );

    const hybridData = hybrid.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ id: string; matchReason: string }>;
    };
    assert.equal(hybrid.exitCode, 0);
    assert.equal(hybridData.strategy, "keyword");
    assert.equal(hybridData.degraded, true);
    assert.equal(hybridData.results[0]?.id, "src_gmail_main:email:msg_1");
    assert.equal(hybrid.stdout._notice?.search?.message.includes("降级"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runPersonalIndexRefresh returns provider_unavailable when embeddings fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-index-fail-"));

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

    const refresh = await runPersonalIndexRefresh(
      runtime,
      { pending: true },
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
            return false;
          },
        },
      },
    );

    assert.equal(refresh.exitCode, 1);
    assert.equal(refresh.stdout.error?.type, "provider_unavailable");
    assert.equal(refresh.stdout.error?.code, "UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic search returns provider_unavailable when embeddings fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-semantic-fail-"));

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
                  subject: "Semantic fail",
                  preview: {
                    body: "Embedding provider should fail here.",
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

    const semantic = await searchPersonalItems(
      runtime,
      {
        query: "embedding fail",
        strategy: "semantic",
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

    assert.equal(semantic.exitCode, 1);
    assert.equal(semantic.stdout.error?.type, "provider_unavailable");
    assert.equal(semantic.stdout.error?.code, "UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hybrid search degrades to keyword when embeddings fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-personal-hybrid-embed-fail-"));

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
                  subject: "Hybrid fail",
                  preview: {
                    body: "Fallback should still return this item.",
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

    const hybrid = await searchPersonalItems(
      runtime,
      {
        query: "fallback",
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

    const hybridData = hybrid.stdout.data as {
      strategy: string;
      degraded: boolean;
      results: Array<{ id: string }>;
    };
    assert.equal(hybrid.exitCode, 0);
    assert.equal(hybridData.strategy, "keyword");
    assert.equal(hybridData.degraded, true);
    assert.equal(hybridData.results[0]?.id, "src_gmail_main:email:msg_1");
    assert.equal(hybrid.stdout._notice?.search?.message.includes("降级"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
