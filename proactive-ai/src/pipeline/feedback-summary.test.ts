// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPinCli } = vi.hoisted(() => ({
  runPinCli: vi.fn(),
}));

vi.mock("./pin-cli.js", () => ({
  runPinCli,
}));

import {
  formatRecentFeedbackSummary,
  loadRecentFeedbackSummary,
} from "./feedback-summary.js";

describe("feedback-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there are no recent actionable signals", async () => {
    runPinCli
      .mockResolvedValueOnce({
        ok: true,
        data: [],
        error: null,
        meta: { domain: "feedback", command: "list", requestId: "req_1", timestamp: "2026-04-07T10:00:00.000Z" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { totalCount: 0 },
        error: null,
        meta: { domain: "feedback", command: "stats", requestId: "req_2", timestamp: "2026-04-07T10:00:00.000Z" },
      });

    const summary = await loadRecentFeedbackSummary();

    expect(summary).toBeNull();
    expect(formatRecentFeedbackSummary(summary)).toBe("");
  });

  it("extracts confirm, modify, dismiss, and text preference patterns", async () => {
    runPinCli
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: "fe_1",
            kind: "card_action",
            action: "confirm",
            basket: "work",
            createdAt: "2026-04-07T09:00:00.000Z",
            metadata: { intentKey: "work:review-queue-with-alex" },
          },
          {
            id: "fe_2",
            kind: "card_action",
            action: "confirm",
            basket: "work",
            createdAt: "2026-04-06T09:00:00.000Z",
            metadata: { intentKey: "work:review-queue-with-alex" },
          },
          {
            id: "fe_3",
            kind: "card_action",
            action: "modify",
            basket: "health",
            createdAt: "2026-04-05T09:00:00.000Z",
            metadata: { intentKey: "health:adjust-evening-walk-plan" },
          },
          {
            id: "fe_4",
            kind: "dismiss",
            basket: "life",
            createdAt: "2026-04-04T09:00:00.000Z",
            metadata: { intentKey: "life:review-weekend-plan" },
          },
          {
            id: "fe_5",
            kind: "text_feedback",
            basket: "work",
            source: "user_derived",
            text: "Prefer morning work briefings",
            createdAt: "2026-04-07T08:00:00.000Z",
            metadata: {},
          },
        ],
        error: null,
        meta: { domain: "feedback", command: "list", requestId: "req_3", timestamp: "2026-04-07T10:00:00.000Z" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { totalCount: 5 },
        error: null,
        meta: { domain: "feedback", command: "stats", requestId: "req_4", timestamp: "2026-04-07T10:00:00.000Z" },
      });

    const summary = await loadRecentFeedbackSummary({ since: "14d" });

    expect(summary).not.toBeNull();
    expect(summary?.confirmPatterns).toEqual([
      {
        basket: "work",
        count: 2,
        intentKeys: ["work:review-queue-with-alex"],
      },
    ]);
    expect(summary?.modifyPatterns).toEqual([
      {
        basket: "health",
        count: 1,
        intentKeys: ["health:adjust-evening-walk-plan"],
      },
    ]);
    expect(summary?.dismissPatterns).toEqual([
      {
        basket: "life",
        count: 1,
        intentKeys: ["life:review-weekend-plan"],
      },
    ]);
    expect(summary?.textPreferences).toEqual(["Prefer morning work briefings"]);

    const promptText = formatRecentFeedbackSummary(summary);
    expect(promptText).toContain("Recent feedback window: last 14d");
    expect(promptText).toContain("Frequently confirmed");
    expect(promptText).toContain("Frequently modified");
    expect(promptText).toContain("Frequently dismissed");
    expect(promptText).toContain("Prefer morning work briefings");
  });
});
