import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRecentFeedbackSummary,
  loadRecentFeedbackSummary,
} from "./feedback-summary.ts";

test("loadRecentFeedbackSummary aggregates confirm, modify, dismiss, and chat-interest signals", async () => {
  const summary = await loadRecentFeedbackSummary(
    { since: "14d", limit: 200 },
    {
      listFeedback: async () => [
        {
          kind: "card_action",
          action: "confirm",
          basket: "work",
          source: "user_direct",
          metadata: { intentKey: "work:review-queue-with-alex" },
          created_at: "2026-04-12T10:00:00.000Z",
        },
        {
          kind: "card_action",
          action: "modify",
          basket: "health",
          source: "user_direct",
          metadata: { intentKey: "health:adjust-evening-walk-plan" },
          created_at: "2026-04-12T09:00:00.000Z",
        },
        {
          kind: "dismiss",
          basket: "life",
          source: "user_direct",
          metadata: { intentKey: "life:review-weekend-plan" },
          created_at: "2026-04-12T08:00:00.000Z",
        },
        {
          kind: "text_feedback",
          source: "user_derived",
          text: "Prefer concise health nudges",
          created_at: "2026-04-12T07:00:00.000Z",
          metadata: {},
        },
        {
          kind: "text_feedback",
          source: "agent_analysis",
          basket: "work",
          text: "User wants a concrete follow-up on hiring outreach.",
          created_at: "2026-04-12T06:00:00.000Z",
          metadata: {
            analysisType: "card_chat_interest",
            intentKey: "work:draft-hiring-outreach",
            topics: ["hiring", "follow-up"],
            nextAngles: ["draft outreach"],
          },
        },
      ],
      feedbackStats: async () => ({ total: 5 }),
    },
  );

  assert.deepEqual(summary, {
    since: "14d",
    totalCount: 5,
    confirmPatterns: [{ basket: "work", count: 1, intentKeys: ["work:review-queue-with-alex"] }],
    modifyPatterns: [{ basket: "health", count: 1, intentKeys: ["health:adjust-evening-walk-plan"] }],
    dismissPatterns: [{ basket: "life", count: 1, intentKeys: ["life:review-weekend-plan"] }],
    textPreferences: ["Prefer concise health nudges"],
    chatInterestPatterns: [{ basket: "work", count: 1, intentKeys: ["work:draft-hiring-outreach"] }],
    chatTopics: ["hiring", "follow-up"],
    chatNextAngles: ["draft outreach"],
  });
});

test("formatRecentFeedbackSummary includes card-chat lines", () => {
  const formatted = formatRecentFeedbackSummary({
    since: "14d",
    totalCount: 5,
    confirmPatterns: [{ basket: "work", count: 1, intentKeys: ["work:review-queue-with-alex"] }],
    modifyPatterns: [],
    dismissPatterns: [],
    textPreferences: ["Prefer concise health nudges"],
    chatInterestPatterns: [{ basket: "work", count: 1, intentKeys: ["work:draft-hiring-outreach"] }],
    chatTopics: ["hiring", "follow-up"],
    chatNextAngles: ["draft outreach"],
  });

  assert.match(formatted, /Recent feedback window: 5 events/);
  assert.match(formatted, /Frequently confirmed: work cards \(1\)/);
  assert.match(formatted, /Sustained card chats: work cards \(1\)/);
  assert.match(formatted, /Chat-derived topics: hiring \| follow-up/);
  assert.match(formatted, /Chat-derived follow-up angles: draft outreach/);
});
