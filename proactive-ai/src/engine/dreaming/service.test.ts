import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as core from "../../core/index.js";
import { profile } from "../../core/index.js";
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

function createDreamApi(json?: string): Parameters<typeof runDreaming>[0]["api"] {
  const content = json ?? `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "Dreaming found one concrete thread worth remembering.",
    "highlights": ["Concrete work follow-up"]
  },
  "highlights": ["Concrete work follow-up"],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n今天我替你记下了一条还值得明天继续记住的工作线索。\\n",
  "interestTopics": []
}
\`\`\``;

  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        run: vi.fn().mockResolvedValue({ runId: `dream-subagent-${Date.now().toString(36)}` }),
        waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
        getSessionMessages: vi.fn().mockResolvedValue({
          messages: [
            {
              role: "assistant",
              content,
            },
          ],
        }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as unknown as Parameters<typeof runDreaming>[0]["api"];
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

async function createMemoryRepository(ctx: CoreContext): Promise<core.MemoryRepository> {
  const manager = new core.PinDatabaseManager(core.resolveAppRootFromCtx(ctx));
  await manager.init();
  return new core.MemoryRepository(manager.open("pin"));
}

describe("runDreaming", () => {
  it("fails fast when runtime subagent is unavailable", async () => {
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

    await expect(runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      sources,
    })).rejects.toThrow(/runtime subagent/i);
  });

  it("does not call fetch-based fallbacks when runtime subagent is unavailable", async () => {
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
      await expect(runDreaming({
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
      })).rejects.toThrow(/runtime subagent/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("collects dynamic connector context instead of hardcoded connector branches", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const executeTool = vi.fn(async (slug: string, args?: Record<string, unknown>, connectedAccountId?: string) => {
      if (slug === "GMAIL_FETCH_EMAILS") {
        expect(connectedAccountId).toBe("gmail-1");
        return {
          tool: slug,
          success: true,
          error: null,
          data: {
            messages: [
              {
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
              {
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
            ],
          },
        };
      }

      if (slug === "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS") {
        expect(connectedAccountId).toBe("gcal-1");
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
            ],
          },
        };
      }

      if (slug === "SLACK_SEARCH_MESSAGES") {
        expect(args).toMatchObject({
          query: expect.stringContaining("after:2026-04-08"),
        });
        expect(connectedAccountId).toBe("slack-1");
        return {
          tool: slug,
          success: true,
          error: null,
          data: {
            messages: [
              {
                ts: "1775772000.000000",
                text: "Xi shared the new big-ball design and asked for product feedback.",
                channel: "pinai-team-2026",
                permalink: "https://slack.com/archives/C123/p1775778000000000",
              },
            ],
          },
        };
      }

      if (slug === "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER") {
        expect(args).toMatchObject({
          since: "2026-04-08T23:00:00.000Z",
          state: "all",
        });
        expect(connectedAccountId).toBe("github-1");
        return {
          tool: slug,
          success: true,
          error: null,
          data: [
            {
              title: "Review PAT approval backlog",
              body: "Members are waiting on PAT approval for the PIN-AI org.",
              updated_at: "2026-04-09T21:19:31Z",
              html_url: "https://github.com/PIN-AI/PIN-AI-ASSISTANT/issues/123",
            },
          ],
        };
      }

      return { tool: slug, success: true, error: null, data: [] };
    });

    const searchTools = vi.fn(async (_query: string, options?: { toolkit?: string }) => {
      switch (options?.toolkit) {
        case "gmail":
          return [{ slug: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail messages" }];
        case "googlecalendar":
          return [{ slug: "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", description: "List calendar events" }];
        case "slack":
          return [{ slug: "SLACK_SEARCH_MESSAGES", description: "Search Slack messages" }];
        case "github":
          return [{ slug: "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", description: "List assigned issues" }];
        default:
          return [];
      }
    });

    const getToolSchema = vi.fn(async (slug: string) => ({
      slug,
      description: slug,
      parameters: {
        GMAIL_FETCH_EMAILS: {
          type: "object",
          properties: {
            max_results: { type: "integer" },
            query: { type: "string" },
          },
        },
        GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
          type: "object",
          required: ["time_min", "time_max"],
          properties: {
            time_min: { type: "string" },
            time_max: { type: "string" },
            summary_only: { type: "boolean" },
          },
        },
        SLACK_SEARCH_MESSAGES: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            count: { type: "integer" },
            sort: { type: "string" },
          },
        },
        GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER: {
          type: "object",
          properties: {
            since: { type: "string" },
            state: { type: "string" },
            filter: { type: "string" },
            per_page: { type: "integer" },
          },
        },
      }[slug] ?? {},
    }));

    const providerSpy = vi.spyOn(core, "createPersonalProvider").mockReturnValue({
      async discoverConnections() {
        return [
          { toolkit: "gmail", status: "ACTIVE", connectedAccountId: "gmail-1", userInfo: null, redirectUrl: null },
          { toolkit: "googlecalendar", status: "ACTIVE", connectedAccountId: "gcal-1", userInfo: null, redirectUrl: null },
          { toolkit: "slack", status: "ACTIVE", connectedAccountId: "slack-1", userInfo: null, redirectUrl: null },
          { toolkit: "github", status: "ACTIVE", connectedAccountId: "github-1", userInfo: null, redirectUrl: null },
        ];
      },
      async checkConnections() { return []; },
      async connectApp() { throw new Error("not used"); },
      async waitForConnection() { throw new Error("not used"); },
      searchTools,
      getToolSchema,
      async disconnectAccount() { throw new Error("not used"); },
      async resolveAccountIdentity() { return null; },
      executeTool,
    });

    try {
      const result = await runDreaming({
        ctx,
        trigger: "manual",
        now: new Date("2026-04-09T23:00:00.000Z"),
        api: {
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
          runtime: {
            subagent: {
              run: vi.fn().mockResolvedValue({ runId: "dream-subagent-dynamic" }),
              waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
              getSessionMessages: vi.fn().mockResolvedValue({
                messages: [
                  {
                    role: "assistant",
                    content: `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "我从 Slack、GitHub、Gmail 和日历里看到了值得跟进的工作线索。",
    "highlights": ["Slack design thread", "GitHub PAT approvals"]
  },
  "highlights": ["Slack design thread", "GitHub PAT approvals"],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n今天我从 Slack、GitHub、Gmail 和日历里重新拼出了几条值得跟进的线索。\\n",
  "interestTopics": ["slack", "github", "product"]
}
\`\`\``,
                  },
                ],
              }),
              deleteSession: vi.fn().mockResolvedValue(undefined),
            },
          },
        } as unknown as Parameters<typeof runDreaming>[0]["api"],
      });

      const personalEntries = Array.isArray(result.detail.normalizedInputs.personal)
        ? result.detail.normalizedInputs.personal as Array<Record<string, unknown>>
        : [];

      expect(personalEntries.length).toBeGreaterThanOrEqual(5);
      expect(personalEntries.some((entry) => entry.connector === "gmail")).toBe(true);
      expect(personalEntries.some((entry) => entry.connector === "googlecalendar")).toBe(true);
      expect(personalEntries.some((entry) => entry.connector === "slack")).toBe(true);
      expect(personalEntries.some((entry) => entry.connector === "github")).toBe(true);

      const slackEntry = personalEntries.find((entry) => entry.connector === "slack");
      expect(JSON.stringify(slackEntry)).toContain("big-ball design");

      const githubEntry = personalEntries.find((entry) => entry.connector === "github");
      expect(JSON.stringify(githubEntry)).toContain("PAT approval");

      expect(searchTools).toHaveBeenCalled();
      expect(result.detail.dreamMarkdown).toContain("Slack、GitHub、Gmail 和日历");
    } finally {
      providerSpy.mockRestore();
    }
  });

  it("prefers connector-specific read tools over misleading generic matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const executeTool = vi.fn(async (slug: string, args?: Record<string, unknown>, connectedAccountId?: string) => {
      switch (slug) {
        case "GMAIL_FETCH_EMAILS":
          expect(connectedAccountId).toBe("gmail-1");
          expect(args).toMatchObject({ max_results: 100, include_payload: true });
          return {
            tool: slug,
            success: true,
            error: null,
            data: {
              messages: [
                {
                  subject: "Review Anthropic invoice",
                  preview: { body: "Invoice attached for March usage." },
                  messageTimestamp: "2026-04-09T14:15:22Z",
                },
              ],
            },
          };
        case "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS":
          expect(connectedAccountId).toBe("gcal-1");
          expect(args).toMatchObject({
            time_min: "2026-04-08T23:00:00.000Z",
            time_max: "2026-04-09T23:00:00.000Z",
            single_events: true,
          });
          expect(args).not.toHaveProperty("query");
          return {
            tool: slug,
            success: true,
            error: null,
            data: {
              event_data: [
                {
                  summary: "Product & Engineering Daily Sync",
                  start: { dateTime: "2026-04-09T07:30:00+08:00" },
                  htmlLink: "https://calendar.google.com/event?daily-sync",
                },
              ],
            },
          };
        case "SLACK_SEARCH_ALL":
          expect(connectedAccountId).toBe("slack-1");
          expect(args).toMatchObject({
            query: expect.stringContaining("after:2026-04-08"),
            count: 100,
            sort: "timestamp",
          });
          return {
            tool: slug,
            success: true,
            error: null,
            data: {
              messages: [
                {
                  ts: "1775772000.000000",
                  text: "Xi shared the new big-ball design and asked for product feedback.",
                  channel: { name: "pinai-team-2026" },
                  permalink: "https://slack.com/archives/C123/p1775772000000000",
                },
              ],
            },
          };
        case "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER":
          expect(connectedAccountId).toBe("github-1");
          expect(args).toMatchObject({
            since: "2026-04-08T23:00:00.000Z",
            state: "all",
            filter: "assigned",
          });
          return {
            tool: slug,
            success: true,
            error: null,
            data: [
              {
                title: "Review PAT approval backlog",
                body: "Members are waiting on PAT approval for the PIN-AI org.",
                updated_at: "2026-04-09T21:19:31Z",
                html_url: "https://github.com/PIN-AI/PIN-AI-ASSISTANT/issues/123",
              },
            ],
          };
        default:
          throw new Error(`unexpected tool ${slug}`);
      }
    });

    const searchTools = vi.fn(async (_query: string, options?: { toolkit?: string }) => {
      switch (options?.toolkit) {
        case "gmail":
          return [
            { slug: "GMAIL_GET_PROFILE", description: "Get Gmail profile" },
            { slug: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail messages" },
          ];
        case "googlecalendar":
          return [
            { slug: "GOOGLECALENDAR_FIND_EVENT", description: "Find calendar events by search query" },
            { slug: "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", description: "List calendar events across calendars" },
          ];
        case "slack":
          return [
            { slug: "SLACK_FIND_CHANNELS", description: "Find channels in Slack" },
            { slug: "SLACK_SEARCH_ALL", description: "Search all Slack messages and files" },
          ];
        case "github":
          return [
            { slug: "GITHUB_AUTH_USER_DOCKER_CONFLICT_PACKAGES_LIST", description: "List Docker migration conflicts" },
            { slug: "GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", description: "List issues assigned to the authenticated user" },
          ];
        default:
          return [];
      }
    });

    const getToolSchema = vi.fn(async (slug: string) => ({
      slug,
      description: slug,
      parameters: {
        GMAIL_GET_PROFILE: { type: "object", properties: {} },
        GMAIL_FETCH_EMAILS: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: { type: "integer" },
            include_payload: { type: "boolean" },
          },
        },
        GOOGLECALENDAR_FIND_EVENT: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: { type: "integer" },
          },
        },
        GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
          type: "object",
          required: ["time_min", "time_max"],
          properties: {
            time_min: { type: "string" },
            time_max: { type: "string" },
            single_events: { type: "boolean" },
            summary_only: { type: "boolean" },
          },
        },
        SLACK_FIND_CHANNELS: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
        },
        SLACK_SEARCH_ALL: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            count: { type: "integer" },
            sort: { type: "string" },
            sort_dir: { type: "string" },
          },
        },
        GITHUB_AUTH_USER_DOCKER_CONFLICT_PACKAGES_LIST: {
          type: "object",
          properties: {},
        },
        GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER: {
          type: "object",
          properties: {
            since: { type: "string" },
            state: { type: "string" },
            filter: { type: "string" },
            per_page: { type: "integer" },
            direction: { type: "string" },
          },
        },
      }[slug] ?? {},
    }));

    const providerSpy = vi.spyOn(core, "createPersonalProvider").mockReturnValue({
      async discoverConnections() {
        return [
          { toolkit: "gmail", status: "ACTIVE", connectedAccountId: "gmail-1", userInfo: null, redirectUrl: null },
          { toolkit: "googlecalendar", status: "ACTIVE", connectedAccountId: "gcal-1", userInfo: null, redirectUrl: null },
          { toolkit: "slack", status: "ACTIVE", connectedAccountId: "slack-1", userInfo: null, redirectUrl: null },
          { toolkit: "github", status: "ACTIVE", connectedAccountId: "github-1", userInfo: null, redirectUrl: null },
        ];
      },
      async checkConnections() { return []; },
      async connectApp() { throw new Error("not used"); },
      async waitForConnection() { throw new Error("not used"); },
      searchTools,
      getToolSchema,
      async disconnectAccount() { throw new Error("not used"); },
      async resolveAccountIdentity() { return null; },
      executeTool,
    });

    try {
      const result = await runDreaming({
        ctx,
        trigger: "manual",
        now: new Date("2026-04-09T23:00:00.000Z"),
        api: createDreamApi(),
      });

      const calledSlugs = executeTool.mock.calls.map(([slug]) => slug);
      expect(calledSlugs).toContain("GMAIL_FETCH_EMAILS");
      expect(calledSlugs).toContain("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS");
      expect(calledSlugs).toContain("SLACK_SEARCH_ALL");
      expect(calledSlugs).toContain("GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER");
      expect(calledSlugs).not.toContain("GITHUB_AUTH_USER_DOCKER_CONFLICT_PACKAGES_LIST");
      expect(calledSlugs).not.toContain("GOOGLECALENDAR_FIND_EVENT");
      expect(calledSlugs).not.toContain("SLACK_FIND_CHANNELS");

      const personalEntries = Array.isArray(result.detail.normalizedInputs.personal)
        ? result.detail.normalizedInputs.personal as Array<Record<string, unknown>>
        : [];
      expect(personalEntries.some((entry) => entry.connector === "googlecalendar")).toBe(true);
      expect(personalEntries.some((entry) => entry.connector === "slack")).toBe(true);
      expect(personalEntries.some((entry) => entry.connector === "github")).toBe(true);
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
      api: createDreamApi(),
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

  it("retries once with a compact json pass when the first synthesis is invalid json", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

    const run = vi.fn()
      .mockResolvedValueOnce({ runId: "dream-subagent-invalid-json" })
      .mockResolvedValueOnce({ runId: "dream-subagent-json-retry" });
    const waitForRun = vi.fn()
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({ status: "ok" });
    const getSessionMessages = vi.fn()
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: "```json\n{\"summary\":{\"kind\":\"updated\",\"text\":\"半截输出\"",
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
    "text": "我重新压缩成有效 JSON，只保留真正重要的事项。",
    "highlights": ["GitHub PAT approvals"]
  },
  "highlights": ["GitHub PAT approvals"],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n今天我重新整理了重点，只留下有效的后续动作。\\n",
  "interestTopics": ["github"]
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
              count: 1,
              raw: [{ subject: "PAT approvals pending" }],
              normalized: [{ connector: "gmail", title: "PAT approvals pending" }],
            };
          },
        },
      ],
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.run.status).toBe("completed");
    expect(result.detail.summary.text).toContain("有效 JSON");
    expect(result.detail.dreamMarkdown).toContain("重新整理了重点");
    expect(deleteSession).toHaveBeenCalledTimes(2);
  });

  it("trims oversized raw and normalized prompt context before calling the subagent", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

    const run = vi.fn().mockResolvedValue({ runId: "dream-subagent-trim-context" });
    const waitForRun = vi.fn().mockResolvedValue({ status: "ok" });
    const getSessionMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: `\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "只保留了压缩后的上下文。",
    "highlights": []
  },
  "highlights": [],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n今天我看的是压缩过的上下文。\\n",
  "interestTopics": []
}
\`\`\``,
        },
      ],
    });
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    const manyRaw = Array.from({ length: 120 }, (_, index) => ({
      title: `raw-${index}`,
      body: "x".repeat(150),
    }));
    const manyNormalized = Array.from({ length: 120 }, (_, index) => ({
      connector: "gmail",
      title: `normalized-${index}`,
      preview: "y".repeat(120),
    }));

    await runDreaming({
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
              count: manyNormalized.length,
              raw: manyRaw,
              normalized: manyNormalized,
            };
          },
        },
      ],
    });

    const prompt = String(run.mock.calls[0]?.[0]?.extraSystemPrompt ?? "");
    expect(prompt).toContain("raw-0");
    expect(prompt).toContain("normalized-0");
    expect(prompt).not.toContain("raw-119");
    expect(prompt).not.toContain("normalized-119");
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
      api: createDreamApi(),
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

    const memoryRepository = await createMemoryRepository(ctx);
    const events = await memoryRepository.listEvents("default", { limit: 10 });
    const entries = await memoryRepository.listEntries("default", { limit: 10 });

    expect(events.some((event) => event.source === "dreaming")).toBe(true);
    expect(entries.some((entry) => entry.text.includes("Concrete work follow-up"))).toBe(true);
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
      api: createDreamApi(),
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
      api: createDreamApi(),
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

  it("keeps derived interests empty without model-provided interest topics", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

    const result = await runDreaming({
      ctx,
      trigger: "manual",
      now: new Date("2026-04-09T01:00:00.000Z"),
      api: createDreamApi(`\`\`\`json
{
  "summary": {
    "kind": "updated",
    "text": "Dreaming reviewed one invoice email and found no new durable interests.",
    "highlights": ["Anthropic invoice review"]
  },
  "highlights": ["Anthropic invoice review"],
  "candidateCards": [],
  "journalMarkdown": "# Dreaming Journal\\n\\n## 2026-04-09 · manual\\n\\n今天我重新看过一封发票相关邮件，但还没有足够证据形成新的长期兴趣。\\n",
  "interestTopics": []
}
\`\`\``),
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
      api: createDreamApi(),
      sources: [source],
    });
    const second = await runDreaming({
      ctx,
      trigger: "auto",
      now: new Date("2026-04-09T06:00:00.000Z"),
      api: createDreamApi(),
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
      api: createDreamApi(),
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
      api: createDreamApi(),
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
