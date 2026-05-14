import { describe, expect, it, vi } from "vitest";
import {
  cardActions,
  cardCopyUnavailableMessage,
  cardFeedbackEvents,
  cardRelatedRows,
  cardRewardEvents,
  cardTraceRouteId,
  evaluatorStatus,
  feedbackEventKey,
  feedbackText,
} from "./CardView";
import type { CardDetail } from "@/api/reward";

vi.mock("@/auth/supabase", () => ({
  accessToken: async () => "test-token",
  refreshAccessToken: async () => "test-token",
}));

describe("CardView feedback helpers", () => {
  it("clips oversized feedback fields before display", () => {
    const text = feedbackText({ text: "feedback detail ".repeat(40) }, "text", 80);

    expect(text).toContain("...");
    expect(text).not.toContain("feedback detail ".repeat(40).trim());
  });

  it("includes row position with event ids to avoid duplicate keys", () => {
    expect(feedbackEventKey({ id: "evt_1" }, 3)).toBe("3:evt_1");
    expect(feedbackEventKey({ id: 42 }, 3)).toBe("3:42");
  });

  it("falls back to row position when API feedback events omit ids", () => {
    expect(feedbackEventKey({ id: "" }, 0)).toBe("feedback-0");
    expect(feedbackEventKey({}, 1)).toBe("feedback-1");
  });
});

describe("CardView trace routing", () => {
  it("prefers LangSmith run ids for trace routes", () => {
    expect(cardTraceRouteId({ id: "run_pk_1", runId: "root_run_1" })).toBe("root_run_1");
  });

  it("falls back to persisted run ids when root run id is missing", () => {
    expect(cardTraceRouteId({ id: "run_pk_1", runId: "   " })).toBe("run_pk_1");
  });
});

describe("CardView action parsing", () => {
  it("accepts only string action labels and known action types", () => {
    const card = {
      id: "card_1",
      primaryAction: { label: "  Review draft  ", type: "primary" },
      secondaryActions: [
        { label: " Open doc ", type: "primary" },
        { label: 42, type: "primary" },
        { label: "   " },
        { label: "Archive", type: "dangerous" },
        null,
      ],
    } as unknown as CardDetail["card"];

    expect(cardActions(card)).toEqual([
      { label: "Review draft", type: "primary" },
      { label: "Open doc", type: "primary" },
      { label: "Archive", type: "secondary" },
    ]);
  });
});

describe("CardView evaluator status", () => {
  it("distinguishes missing evaluator data from failed evaluations", () => {
    expect(evaluatorStatus(null)).toEqual({ className: "neutral", label: "待确认" });
    expect(evaluatorStatus({ pass: true } as CardDetail["evaluation"])).toEqual({
      className: "ready",
      label: "通过",
    });
    expect(evaluatorStatus({ pass: false } as CardDetail["evaluation"])).toEqual({
      className: "failed",
      label: "未通过",
    });
  });
});

describe("CardView runtime array boundaries", () => {
  it("keeps only object feedback events", () => {
    expect(cardFeedbackEvents({
      feedbackEvents: [{ id: "evt_1" }, null, "bad", { id: "evt_2" }] as unknown as CardDetail["feedbackEvents"],
    })).toEqual([{ id: "evt_1" }, { id: "evt_2" }]);
    expect(cardFeedbackEvents({
      feedbackEvents: "bad" as unknown as CardDetail["feedbackEvents"],
    })).toEqual([]);
  });

  it("keeps only object reward events", () => {
    const rewardHistory = [
      { id: "reward_1", runId: "run_1", cardId: "card_1", source: "user", eventType: "user_score", score: 8, reason: null, metadata: {}, createdAt: "2026-05-14T00:00:00Z" },
      null,
      12,
    ] as unknown as CardDetail["rewardHistory"];

    expect(cardRewardEvents({ rewardHistory })).toHaveLength(1);
    expect(cardRewardEvents({ rewardHistory: "bad" as unknown as CardDetail["rewardHistory"] })).toEqual([]);
  });

  it("keeps only related rows with card snapshots", () => {
    const relatedCards = [
      { runId: "run_1", completedAt: null, card: { id: "card_1" } },
      { runId: "run_2", completedAt: null },
      null,
    ] as unknown as CardDetail["relatedCards"];

    expect(cardRelatedRows({ relatedCards })).toEqual([{ runId: "run_1", completedAt: null, card: { id: "card_1" } }]);
    expect(cardRelatedRows({ relatedCards: "bad" as unknown as CardDetail["relatedCards"] })).toEqual([]);
  });
});

describe("CardView copy readiness", () => {
  it("prevents copying stale or empty card review markdown", () => {
    expect(cardCopyUnavailableMessage("### card", true)).toBe("正在保存人工评分，刷新完成后再复制。");
    expect(cardCopyUnavailableMessage("   ", false)).toBe("当前卡片没有可复制摘要。");
    expect(cardCopyUnavailableMessage("### card", false)).toBeNull();
  });
});
