import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as core from "../../core/index.js";
import { appPaths, profile } from "../../core/index.js";
import type { CoreContext } from "../../core/index.js";
import {
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
  it("creates artifacts and a completed run from collected source data", async () => {
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
    expect(result.detail.candidates.length).toBeGreaterThan(0);
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

  it("keeps rich personal connector context when using the default personal collector", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx);

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
      async disconnectApp() { throw new Error("not used"); },
      async executeTool(slug) {
        if (slug === "GMAIL_FETCH_EMAILS") {
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
              ],
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
      },
    });

    try {
      const result = await runDreaming({
        ctx,
        trigger: "manual",
        now: new Date("2026-04-09T01:00:00.000Z"),
      });

      const personalEntries = Array.isArray(result.detail.normalizedInputs.personal)
        ? result.detail.normalizedInputs.personal as Array<Record<string, unknown>>
        : [];

      expect(personalEntries.length).toBeGreaterThanOrEqual(3);

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
      expect(result.detail.dreamMarkdown).toContain("Product & Engineering Daily Sync");
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
    expect(updatedProfile.preferences).toHaveProperty("dreaming");
    expect(updatedProfile.snapshots.length).toBeGreaterThan(0);
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

  it("writes a readable dreaming markdown summary alongside artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "dream-service-"));
    const ctx = createCtx(root);
    await seedProfile(ctx, "zh-CN");

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
    expect(markdown).toContain("我想先替你记下");
    expect(existsSync(join(result.run.artifactDir as string, "dream.md"))).toBe(true);
  });

  it("prefers local generation language over profile locale for dream journal output", async () => {
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

    expect(result.detail.dreamMarkdown).toContain("昨天我注意到");
    expect(result.detail.dreamMarkdown).not.toContain("Yesterday I noticed");
  });

  it("filters timestamp-like junk tokens from derived interests", async () => {
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
    expect(interestKeys).toContain("anthropic");
    expect(interestKeys).toContain("invoice");
    expect(interestKeys).not.toContain("09t14");
    expect(interestKeys).not.toContain("562z");
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
});
