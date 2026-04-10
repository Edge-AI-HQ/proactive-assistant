import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as core from "../../core/index.js";
import { appPaths, profile } from "../../core/index.js";
import type { CoreContext } from "../../core/index.js";
import {
  applyDreamGoals,
  applyDreamProfile,
  runDreaming,
  type DreamSourceDefinition,
} from "./service.js";

function createCtx(root: string): CoreContext {
  return {
    env: { PIN_DATA_ROOT: root },
    homeDir: root,
  };
}

async function seedProfile(ctx: CoreContext, locale = "en-US") {
  await profile.createProfile(ctx, {
    id: "default",
    displayName: "User",
    timezone: "Asia/Shanghai",
    locale,
    summary: "Test user",
    full: true,
  });
}

describe("runDreaming", () => {
  it("creates artifacts and a completed run with minimal fallback synthesis when no runtime api is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const sources: DreamSourceDefinition[] = [
      {
        id: "personal",
        async collect() {
          return {
            status: "ok",
            count: 2,
            raw: {
              connectors: {
                gmail: [{ subject: "Quarterly review", timestamp: "2026-04-09T00:00:00.000Z" }],
              },
            },
            normalized: [{ connector: "gmail", title: "Quarterly review" }],
          };
        },
      },
      {
        id: "feedback",
        async collect() {
          return {
            status: "ok",
            count: 1,
            raw: [{ kind: "card_action", basket: "work", action: "confirm" }],
            normalized: [{ basket: "work", action: "confirm" }],
          };
        },
      },
      {
        id: "signals",
        async collect() {
          return {
            status: "ok",
            count: 1,
            raw: [{ targetKey: "career-growth", occurredAt: "2026-04-09T00:00:00.000Z" }],
            normalized: [{ key: "career-growth" }],
          };
        },
      },
      {
        id: "cards",
        async collect() {
          return {
            status: "skipped",
            count: 0,
            raw: [],
            normalized: [],
            message: "No recent cards",
          };
        },
      },
    ];

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources,
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.summaryJson?.kind).toBe("updated");
    expect(result.run.profileDeltaJson?.facts.after).toHaveProperty("dreaming");
    expect(result.detail.candidates).toEqual([]);
    expect(result.detail.summary.text).toContain("Dreaming collected");
    expect(result.run.artifactDir).toContain(join(root, "dreams", "2026-04-09", `2026-04-09-01-manual-${result.run.id}`));
    expect(existsSync(join(result.run.artifactDir as string, "inputs.raw.json"))).toBe(true);
    expect(existsSync(join(result.run.artifactDir as string, "profile-delta.json"))).toBe(true);
    expect(existsSync(join(result.run.artifactDir as string, "events.log"))).toBe(true);
    expect(existsSync(join(root, "dreams", "logs", "2026-04-09.log"))).toBe(true);

    const rawInputs = JSON.parse(
      readFileSync(join(result.run.artifactDir as string, "inputs.raw.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(rawInputs).toHaveProperty("personal");
    expect(rawInputs).toHaveProperty("feedback");

    const runLog = readFileSync(join(result.run.artifactDir as string, "events.log"), "utf-8");
    expect(runLog).toContain("run_started");
    expect(runLog).toContain("source_collect_completed");
    expect(result.detail.logText).toContain("run_completed");
  });

  it("ignores OPENAI_API_KEY and stays on minimal fallback when runtime api is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    ctx.env.OPENAI_API_KEY = "sk-test";
    await seedProfile(ctx, "zh-CN");

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (originalFetch) {
        return await originalFetch(...args);
      }
      throw new Error("fetch should not be called in this test");
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const result = await runDreaming({
        ctx,
        trigger: "manual",
        now: new Date("2026-04-10T06:23:57.648Z"),
        sources: [
          {
            id: "personal",
            async collect() {
              return {
                status: "ok",
                count: 2,
                raw: {
                  connectors: {
                    gmail: {
                      messages: [
                        {
                          messageId: "gmail-1",
                          subject: "Verification code for your card transaction",
                          sender: "Brex <noreply@brex.com>",
                          messageTimestamp: "2026-04-09T09:32:36Z",
                        },
                        {
                          messageId: "gmail-2",
                          subject: "[GitHub] Your organization PIN AI has received personal access token requests",
                          sender: "PIN AI <noreply@github.com>",
                          messageTimestamp: "2026-04-09T21:19:31Z",
                        },
                      ],
                    },
                  },
                },
                normalized: [
                  {
                    connector: "gmail",
                    title: "Verification code for your card transaction",
                    sender: "Brex <noreply@brex.com>",
                    timestamp: "2026-04-09T09:32:36Z",
                  },
                  {
                    connector: "gmail",
                    title: "[GitHub] Your organization PIN AI has received personal access token requests",
                    sender: "PIN AI <noreply@github.com>",
                    timestamp: "2026-04-09T21:19:31Z",
                  },
                ],
              };
            },
          },
        ],
      });
      expect(result.detail.summary.text).toContain("等待子代理进一步总结这些上下文");
      expect(result.detail.candidates).toEqual([]);
      expect(result.detail.profileDelta.interests.after).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps rich personal connector context when using the default personal collector", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const executeTool = vi.fn(async (slug: string, args?: Record<string, unknown>) => {
      if (slug === "GMAIL_FETCH_EMAILS") {
        if (args?.page_token === "page-2") {
          return {
            tool: slug,
            success: true,
            error: null,
            data: {
              successful: true,
              data_preview: {
                messages: [
                  {
                    messageId: "gmail-3",
                    threadId: "thread-3",
                  },
                ],
                resultSizeEstimate: 3,
              },
            },
          };
        }
        expect(args).toMatchObject({
          ids_only: true,
          max_results: 500,
          query: expect.stringContaining("after:"),
        });
        return {
          tool: slug,
          success: true,
          error: null,
          data: {
            successful: true,
            data_preview: {
              nextPageToken: "page-2",
              messages: [
                {
                  messageId: "gmail-1",
                  threadId: "thread-1",
                },
                {
                  messageId: "gmail-2",
                  threadId: "thread-2",
                },
                "...more items",
              ],
              resultSizeEstimate: 3,
            },
          },
        };
      }
      if (slug === "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID") {
        const messages: Record<string, Record<string, unknown>> = {
          "gmail-1": {
            messageId: "gmail-1",
            subject: "Review Anthropic invoice",
            sender: "Anthropic Billing <billing@anthropic.com>",
            to: "smile@pinai.io",
            labelIds: ["INBOX", "UNREAD"],
            messageTimestamp: "2026-04-09T14:15:22Z",
            display_url: "https://mail.google.com/mail/u/0/#inbox/example",
            preview: {
              subject: "Review Anthropic invoice",
              body: "Invoice attached for March usage.",
            },
            messageText: "Invoice attached for March usage. Please review before Friday.",
          },
          "gmail-2": {
            messageId: "gmail-2",
            subject: "Prepare board update",
            sender: "Alex <alex@pinai.io>",
            to: "smile@pinai.io",
            labelIds: ["INBOX"],
            messageTimestamp: "2026-04-09T06:45:00Z",
            preview: {
              subject: "Prepare board update",
              body: "Need the topline metrics before the afternoon review.",
            },
            messageText: "Need the topline metrics before the afternoon review.",
          },
          "gmail-3": {
            messageId: "gmail-3",
            subject: "Weekly metrics",
            sender: "Ops <ops@pinai.io>",
            to: "smile@pinai.io",
            labelIds: ["INBOX"],
            messageTimestamp: "2026-04-09T05:10:00Z",
            preview: {
              subject: "Weekly metrics",
              body: "Metrics snapshot for yesterday.",
            },
            messageText: "Metrics snapshot for yesterday.",
          },
        };
        return {
          tool: slug,
          success: true,
          error: null,
          data: {
            successful: true,
            data_preview: messages[String(args?.message_id)],
          },
        };
      }
      if (slug === "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS") {
        return {
          tool: slug,
          success: true,
          error: null,
          data: {
            summary_view: [
              {
                title: "Product & Engineering Daily Sync",
                start: "2026-04-09T07:30:00+08:00",
                end: "2026-04-09T08:30:00+08:00",
                is_all_day: false,
                calendar: "smile@pinai.io",
                display_url: "https://calendar.google.com/event?daily-sync",
              },
              {
                title: "[Reminder] Pin AI Team - Midweek Update",
                start: "2026-04-09T08:00:00+08:00",
                end: "2026-04-09T08:30:00+08:00",
                is_all_day: false,
                calendar: "smile@pinai.io",
                display_url: "https://calendar.google.com/event/midweek",
              },
            ],
            calendars_queried: [{ id: "smile@pinai.io", summary: "smile@pinai.io" }],
            events: [],
          },
        };
      }
      return { tool: slug, success: true, error: null, data: [] };
    });

    const providerSpy = vi.spyOn(core, "createPersonalProvider").mockReturnValue({
      async discoverConnections() {
        return [
          { toolkit: "gmail", status: "ACTIVE", connectedAccountId: "gmail-1", userInfo: null, redirectUrl: null },
          { toolkit: "googlecalendar", status: "ACTIVE", connectedAccountId: "gcal-1", userInfo: null, redirectUrl: null },
        ];
      },
      async checkConnections() { return []; },
      async connectApp() { throw new Error("not used"); },
      async waitForConnection() { throw new Error("not used"); },
      async searchTools() { return []; },
      async getToolSchema() { return null; },
      async disconnectAccount() { throw new Error("not used"); },
      async resolveAccountIdentity() { return null; },
      executeTool,
      executeTool,
    });

    try {
      const result = await runDreaming({
        ctx,
        trigger: "manual",
        now: new Date("2026-04-09T23:00:00.000Z"),
      });

      const personalEntries = Array.isArray(result.detail.normalizedInputs.personal)
        ? result.detail.normalizedInputs.personal as Array<Record<string, unknown>>
        : [];

      expect(personalEntries.length).toBeGreaterThanOrEqual(4);

      const gmailEntry = personalEntries.find((entry) => entry.connector === "gmail");
      expect(gmailEntry).toMatchObject({
        connector: "gmail",
        title: "Review Anthropic invoice",
        sender: "Anthropic Billing <billing@anthropic.com>",
        preview: "Invoice attached for March usage.",
        body: "Invoice attached for March usage. Please review before Friday.",
      });
      expect(gmailEntry?.labels).toEqual(["INBOX", "UNREAD"]);
      expect(gmailEntry?.context).toContain("Anthropic Billing");
      expect(gmailEntry?.context).toContain("Please review before Friday");
      expect(personalEntries.filter((entry) => entry.connector === "gmail")).toHaveLength(3);
      expect(executeTool).toHaveBeenCalledWith("GMAIL_FETCH_EMAILS", expect.objectContaining({
        ids_only: true,
        max_results: 500,
      }), "gmail-1");
      expect(executeTool).toHaveBeenCalledWith("GMAIL_FETCH_EMAILS", expect.objectContaining({
        page_token: "page-2",
      }), "gmail-1");
      expect(executeTool).toHaveBeenCalledWith("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: "gmail-1",
      }, "gmail-1");
      expect(executeTool).toHaveBeenCalledWith("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: "gmail-2",
      }, "gmail-1");
      expect(executeTool).toHaveBeenCalledWith("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
        message_id: "gmail-3",
      }, "gmail-1");
      expect(result.detail.sourceBreakdown[0]?.connectors?.find((item) => item.connectorId === "gmail")?.itemCount).toBe(3);

      const calendarEntry = personalEntries.find((entry) => entry.title === "Product & Engineering Daily Sync");
      expect(calendarEntry).toMatchObject({
        connector: "googlecalendar",
        title: "Product & Engineering Daily Sync",
        calendar: "smile@pinai.io",
        start: "2026-04-09T07:30:00+08:00",
        end: "2026-04-09T08:30:00+08:00",
      });
      expect(calendarEntry?.context).toContain("Product & Engineering Daily Sync");
      expect(calendarEntry?.context).toContain("smile@pinai.io");
      expect(result.detail.dreamMarkdown).toContain("records collected context only");
    } finally {
      providerSpy.mockRestore();
    }
  });

  it("keeps the run completed when some sources error", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "error",
              count: 0,
              raw: [],
              normalized: [],
              message: "provider failed",
            };
          },
        },
      ],
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.sourceStatsJson).toEqual({
      personal: {
        status: "error",
        count: 0,
        message: "provider failed",
      },
    });
  });

  it("prefers model-driven dreaming synthesis when a runtime api is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const runSubagent = vi.fn().mockResolvedValue({ runId: "dream-subagent-1" });
    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: {
          subagent: {
            run: runSubagent,
            waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
            getSessionMessages: vi.fn().mockResolvedValue({
              messages: [
                {
                  role: "assistant",
                  content: `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "我重新看过你的邮件、日历和旧卡片，发现今天最值得关注的是发票处理和早会节奏。",
    "highlights": ["Review Anthropic invoice", "Product & Engineering Daily Sync"]
  },
  "highlights": ["Review Anthropic invoice", "Product & Engineering Daily Sync"],
  "candidateCards": [
    {
      "title": "先处理 Anthropic 发票",
      "basket": "wealth",
      "reason": "邮件里已经出现明确的发票处理请求，适合今天优先确认。",
      "connector": "gmail"
    },
    {
      "title": "为 Product & Engineering Daily Sync 做准备",
      "basket": "work",
      "reason": "今天早上的日历里已经有团队同步会，值得提前聚焦。",
      "connector": "googlecalendar"
    }
  ],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n昨天我重新看了你的邮件、日历和最近卡片。今天最值得我替你记住的是 Anthropic 发票和 Product & Engineering Daily Sync。\\n",
  "interestTopics": ["anthropic", "invoice", "product", "engineering"],
  "goalDelta": {
    "changes": [
      {
        "action": "create",
        "key": "prepare-board-review",
        "reason": "邮件和日历都显示这是一条持续性的工作线索。",
        "before": null,
        "after": {
          "title": "准备 board review 后续事项",
          "priority": "high",
          "summary": "跟踪 board review 相关准备和 follow-up",
          "status": "active"
        }
      }
    ]
  }
}
\`\`\``,
                },
              ],
            }),
            deleteSession,
          },
        },
      } as unknown as Parameters<typeof runDreaming>[0]["api"],
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 2,
              raw: {
                connectors: {
                  gmail: [{ subject: "Review Anthropic invoice" }],
                  googlecalendar: [{ title: "Product & Engineering Daily Sync" }],
                },
              },
              normalized: [
                {
                  connector: "gmail",
                  title: "Review Anthropic invoice",
                  sender: "Anthropic Billing",
                  context: "Review Anthropic invoice | Anthropic Billing | Please review before Friday.",
                },
                {
                  connector: "googlecalendar",
                  title: "Product & Engineering Daily Sync",
                  calendar: "smile@pinai.io",
                  context: "Product & Engineering Daily Sync | smile@pinai.io | 2026-04-09T07:30:00+08:00",
                },
              ],
            };
          },
        },
      ],
    });

    expect(result.detail.summary.text).toContain("发票处理和早会节奏");
    expect(result.detail.candidates).toHaveLength(2);
    expect(result.detail.candidates[0]?.title).toBe("先处理 Anthropic 发票");
    expect(result.detail.dreamMarkdown).toContain("昨天我重新看了你的邮件、日历和最近卡片");
    expect(result.detail.profileDelta.interests.after.map((item) => item.key)).toEqual([
      "anthropic",
      "invoice",
      "product",
      "engineering",
    ]);
    expect(result.detail.goalDelta.changes).toHaveLength(1);
    expect(result.detail.goalDelta.changes[0]?.key).toBe("prepare-board-review");
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("goalDelta.reason/after.title/after.summary must be written in Simplified Chinese"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("all-day placeholders like \"Home\""),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("OTP/verification emails"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("still worth remembering tomorrow morning"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("You are expected to discard most inputs"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("If currentProfile.displayName is available, naturally mention the user's name once"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("not a status report, meeting recap, or changelog"),
    }));
    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining("Never invent weather, mood, or offline life details"),
    }));
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("retries with a deeper model pass when the first synthesis says no_new_data despite personal context", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

    const run = vi.fn()
      .mockResolvedValueOnce({ runId: "dream-subagent-1" })
      .mockResolvedValueOnce({ runId: "dream-subagent-2" });
    const waitForRun = vi.fn()
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({ status: "ok" });
    const getSessionMessages = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: `\`\`\`json
{
  "summary": {
    "kind": "no_new_data",
    "text": "当前窗口没有明确的新事项。",
    "highlights": []
  },
  "highlights": [],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n这轮没有什么值得记录。\\n",
  "interestTopics": []
}
\`\`\``,
          },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "我重新深挖后，确认今天最值得关注的是 Anthropic 发票和早上的团队同步会。",
    "highlights": ["Review Anthropic invoice", "Product & Engineering Daily Sync"]
  },
  "highlights": ["Review Anthropic invoice", "Product & Engineering Daily Sync"],
  "candidateCards": [
    {
      "title": "今天先确认 Anthropic 发票",
      "basket": "wealth",
      "reason": "邮件正文已经明确要求 review before Friday，不该被忽略。",
      "connector": "gmail"
    }
  ],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n我重新看过你的邮件和今早的日历，最该先记住的是 Anthropic 发票和 Product & Engineering Daily Sync。\\n",
  "interestTopics": ["anthropic", "invoice", "product"]
}
\`\`\``,
          },
        ],
      });
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: {
          subagent: {
            run,
            waitForRun,
            getSessionMessages,
            deleteSession,
          },
        },
      } as unknown as Parameters<typeof runDreaming>[0]["api"],
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 2,
              raw: {
                connectors: {
                  gmail: [{ subject: "Review Anthropic invoice" }],
                  googlecalendar: [{ title: "Product & Engineering Daily Sync" }],
                },
              },
              normalized: [
                {
                  connector: "gmail",
                  title: "Review Anthropic invoice",
                  sender: "Anthropic Billing",
                  context: "Review Anthropic invoice | Anthropic Billing | Please review before Friday.",
                },
                {
                  connector: "googlecalendar",
                  title: "Product & Engineering Daily Sync",
                  calendar: "smile@pinai.io",
                  context: "Product & Engineering Daily Sync | smile@pinai.io | 2026-04-09T07:30:00+08:00",
                },
              ],
            };
          },
        },
      ],
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.detail.summary.kind).toBe("updated");
    expect(result.detail.summary.text).toContain("Anthropic 发票和早上的团队同步会");
    expect(result.detail.candidates[0]?.title).toBe("今天先确认 Anthropic 发票");
    expect(result.detail.dreamMarkdown).toContain("我重新看过你的邮件和今早的日历");
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });

  it("applies the latest dream profile diff to the default profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [
        {
          id: "feedback",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: [{ kind: "card_action", basket: "work", action: "confirm" }],
              normalized: [{ basket: "work", action: "confirm" }],
            };
          },
        },
      ],
    });

    const applied = await applyDreamProfile({
      ctx,
      runId: result.run.id,
    });

    expect(applied.appliedAt).toBeTruthy();

    const updatedProfile = await profile.getProfile(ctx, "default", true) as {
      facts: Record<string, unknown>;
      preferences: Record<string, unknown>;
      snapshots: Array<Record<string, unknown>>;
    };

    expect(updatedProfile.facts).toHaveProperty("dreaming");
    expect(updatedProfile.snapshots.length).toBeGreaterThan(0);
  });

  it("applies dream goal changes separately from profile changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: {
          subagent: {
            run: vi.fn().mockResolvedValue({ runId: "dream-subagent-goals" }),
            waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
            getSessionMessages: vi.fn().mockResolvedValue({
              messages: [
                {
                  role: "assistant",
                  content: `\`\`\`json
{
  "summary": { "kind": "updated", "text": "我识别出一条持续性的目标线索。", "highlights": [] },
  "highlights": [],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n我识别出一条持续性的目标线索。\\n",
  "interestTopics": [],
  "goalDelta": {
    "changes": [
      {
        "action": "create",
        "key": "board-review-follow-up",
        "reason": "最近的上下文显示 board review follow-up 已经是持续目标。",
        "before": null,
        "after": {
          "title": "Track board review follow-up",
          "priority": "high",
          "summary": "Keep board review follow-up visible."
        }
      }
    ]
  }
}
\`\`\``,
                },
              ],
            }),
            deleteSession: vi.fn().mockResolvedValue(undefined),
          },
        },
      } as unknown as Parameters<typeof runDreaming>[0]["api"],
      sources: [
        {
          id: "personal",
          async collect() {
            return { status: "ok", count: 1, raw: {}, normalized: [{ connector: "gmail", title: "Board review" }] };
          },
        },
      ],
    });

    const detailBeforeApply = result.detail.goalDelta.changes[0];
    expect(detailBeforeApply?.key).toBe("board-review-follow-up");

    const applied = await applyDreamGoals({ ctx, runId: result.run.id });
    expect(applied.goalsAppliedAt).toBeTruthy();

    const goals = await profile.listGoals(ctx);
    expect(goals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "board-review-follow-up",
        title: "Track board review follow-up",
        priority: "high",
      }),
    ]));
  });

  it("does not mutate the profile when applying a superseded dream run", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const first = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [
        {
          id: "feedback",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: [{ kind: "card_action", basket: "work", action: "confirm" }],
              normalized: [{ basket: "work", action: "confirm" }],
            };
          },
        },
      ],
    });

    await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T02:00:00.000Z"),
      sources: [
        {
          id: "feedback",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: [{ kind: "card_action", basket: "health", action: "dismiss" }],
              normalized: [{ basket: "health", action: "dismiss" }],
            };
          },
        },
      ],
    });

    const beforeProfile = await profile.getProfile(ctx, "default", true);
    await expect(applyDreamProfile({ ctx, runId: first.run.id })).rejects.toThrow(/superseded/i);
    const afterProfile = await profile.getProfile(ctx, "default", true);

    expect(afterProfile).toEqual(beforeProfile);
  });

  it("writes the model-produced dreaming markdown alongside artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

    const deleteSession = vi.fn().mockResolvedValue(undefined);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      api: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: {
          subagent: {
            run: vi.fn().mockResolvedValue({ runId: "dream-subagent-md" }),
            waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
            getSessionMessages: vi.fn().mockResolvedValue({
              messages: [
                {
                  role: "assistant",
                  content: `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "我重新看过你的邮件和日历，Anthropic invoice 和 Product daily sync 都值得记住。",
    "highlights": ["Anthropic invoice", "Product daily sync"]
  },
  "highlights": ["Anthropic invoice", "Product daily sync"],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n昨天我注意到 Anthropic invoice 和 Product daily sync 这两条线索值得继续跟进。\\n",
  "interestTopics": ["anthropic", "invoice", "product"]
}
\`\`\``,
                },
              ],
            }),
            deleteSession,
          },
        },
      } as unknown as Parameters<typeof runDreaming>[0]["api"],
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 2,
              raw: {
                connectors: {
                  gmail: [{ subject: "Review Anthropic invoice", timestamp: "2026-04-09T00:00:00.000Z" }],
                  googlecalendar: [{ title: "Product daily sync", start: "2026-04-10T07:30:00.000Z" }],
                },
              },
              normalized: [
                { connector: "gmail", title: "Review Anthropic invoice", timestamp: "2026-04-09T00:00:00.000Z" },
                { connector: "googlecalendar", title: "Product daily sync", timestamp: "2026-04-10T07:30:00.000Z" },
              ],
            };
          },
        },
      ],
    });

    const markdownPath = join(root, "dreams", "dreaming.md");
    expect(existsSync(markdownPath)).toBe(true);

    const markdown = readFileSync(markdownPath, "utf-8");
    expect(markdown).toContain("昨天我注意到");
    expect(markdown).toContain("Anthropic invoice");
    expect(markdown).toContain("Product daily sync");
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(existsSync(join(result.run.artifactDir as string, "dream.md"))).toBe(true);
  });

  it("uses a localized minimal fallback journal when no model output is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "en-US");
    const settingsPath = appPaths.localSettings(root);
    writeFileSync(settingsPath, JSON.stringify({
      generation: {
        language: "zh-Hans",
      },
    }, null, 2));

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: {
                connectors: {
                  gmail: [{ subject: "Review Anthropic invoice" }],
                },
              },
              normalized: [
                { connector: "gmail", title: "Review Anthropic invoice", timestamp: "2026-04-09T00:00:00.000Z" },
              ],
            };
          },
        },
      ],
    });

    expect(result.detail.dreamMarkdown).toContain("本次 Dreaming 记录");
    expect(result.detail.dreamMarkdown).not.toContain("Yesterday I noticed");
  });

  it("keeps derived interests empty without model-provided interest topics", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: {
                connectors: {
                  gmail: [{ subject: "Anthropic invoice review", timestamp: "2026-04-09T14:30:54.562Z" }],
                },
              },
              normalized: [
                {
                  connector: "gmail",
                  title: "Anthropic invoice review",
                  timestamp: "2026-04-09T14:30:54.562Z",
                },
              ],
            };
          },
        },
      ],
    });

    const interestKeys = result.detail.profileDelta.interests.after.map((item) => item.key);
    expect(interestKeys).toEqual([]);
  });

  it("increments the readable daily run folder suffix for multiple runs on the same day", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const source: DreamSourceDefinition = {
      id: "personal",
      async collect() {
        return {
          status: "ok",
          count: 1,
          raw: { connectors: { gmail: [{ subject: "Morning review" }] } },
          normalized: [{ connector: "gmail", title: "Morning review" }],
        };
      },
    };

    const first = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources: [source],
    });
    const second = await runDreaming({
      ctx,
      trigger: "auto",
      now: new Date("2026-04-09T06:00:00.000Z"),
      sources: [source],
    });

    expect(first.run.artifactDir).toContain(join(root, "dreams", "2026-04-09", `2026-04-09-01-manual-${first.run.id}`));
    expect(second.run.artifactDir).toContain(join(root, "dreams", "2026-04-09", `2026-04-09-02-auto-${second.run.id}`));
  });

  it("uses a full 24-hour dreaming window even when a recent successful run exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T15:00:00.000Z"),
      sources: [
        {
          id: "personal",
          async collect() {
            return {
              status: "ok",
              count: 1,
              raw: { connectors: { gmail: [{ subject: "Earlier run" }] } },
              normalized: [{ connector: "gmail", title: "Earlier run" }],
            };
          },
        },
      ],
    });

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T15:27:37.582Z"),
      sources: [
        {
          id: "personal",
          async collect({ windowStart, windowEnd }) {
            return {
              status: "ok",
              count: 0,
              raw: { windowStart, windowEnd },
              normalized: [],
            };
          },
        },
      ],
    });

    expect(result.run.windowEnd).toBe("2026-04-09T15:27:37.582Z");
    expect(result.run.windowStart).toBe("2026-04-08T15:27:37.582Z");
    expect(result.detail.rawInputs.personal).toEqual({
      windowStart: "2026-04-08T15:27:37.582Z",
      windowEnd: "2026-04-09T15:27:37.582Z",
    });
  });
});
