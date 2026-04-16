import test from "node:test";
import assert from "node:assert/strict";

import {
  CARD_CHAT_INTEREST_ANALYSIS_TYPE,
  getCardChatSessionKey,
  hashNormalizedCardChatMessages,
  normalizeCardChatMessages,
  syncCardChatFeedback,
} from "./service.ts";

test("normalizeCardChatMessages filters injected first-turn prompts and duplicate assistant replies", () => {
  const messages = normalizeCardChatMessages([
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: 'The user opened "Quiet Hours". Suggested action: "Enable quiet hours". Confirm details briefly, then execute.' },
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: "Can you draft the outreach?" },
    { role: "assistant", content: [{ type: "text", text: "Yes — I'll draft it." }] },
  ]);

  assert.deepEqual(messages, [
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: "Can you draft the outreach?" },
    { role: "assistant", content: "Yes — I'll draft it." },
  ]);
});

test("syncCardChatFeedback summarizes qualified changed card chats into agent_analysis feedback rows", async () => {
  const records = [
    {
      cardId: "card_1",
      goalBasket: "work",
      title: "Draft hiring outreach",
      titleKey: "draft-hiring-outreach",
      generatedAt: "2026-04-12T01:00:00.000Z",
    },
  ];
  const transcript = [
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: 'The user opened "Draft hiring outreach". Suggested action: "Draft outreach". Confirm details briefly, then execute.' },
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: "Can you draft the hiring outreach email?" },
    { role: "assistant", content: "Yes — I can draft it and propose recipients." },
    { role: "user", content: "Also help me decide who should get the first pass today." },
    { role: "assistant", content: "We can prioritize the warm leads first." },
    { role: "user", content: "Great, and suggest a follow-up cadence I can use." },
  ];

  const writes: unknown[] = [];
  const decisions: unknown[] = [];
  const normalized = normalizeCardChatMessages(transcript);

  const result = await syncCardChatFeedback(
    {
      api: {} as never,
      trigger: "manual",
    },
    {
      listRecentGeneratedCards: async () => records,
      listFeedback: async () => [],
      getSessionMessages: async () => transcript,
      summarizeEligibleChats: async () => ({
        signals: [
          {
            cardId: "card_1",
            summary: "User kept drilling into the executable hiring follow-up.",
            decision: "refine",
            topics: ["hiring", "follow-up"],
            nextAngles: ["draft outreach", "schedule follow-up"],
          },
        ],
      }),
      applyChatDecision: async (input) => {
        decisions.push(input);
      },
      logFeedback: async (input) => {
        writes.push(input);
      },
    },
  );

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    kind: "text_feedback",
    source: "agent_analysis",
    intentCardId: "card_1",
    conversationId: getCardChatSessionKey("card_1"),
    basket: "work",
    channel: "web",
    text: "User kept drilling into the executable hiring follow-up.",
      metadata: {
        analysisType: CARD_CHAT_INTEREST_ANALYSIS_TYPE,
        intentKey: "work:draft-hiring-outreach",
        decision: "refine",
        titleKey: "draft-hiring-outreach",
        title: "Draft hiring outreach",
        generatedAt: "2026-04-12T01:00:00.000Z",
        transcriptHash: hashNormalizedCardChatMessages(normalized),
        messageCount: normalized.length,
        userTurns: 3,
        userTextChars: 145,
        topics: ["hiring", "follow-up"],
        nextAngles: ["draft outreach", "schedule follow-up"],
        trigger: "manual",
    },
  });
  assert.deepEqual(result, {
    scannedCards: 1,
    qualifiedCards: 1,
    summarizedCards: 1,
    writtenFeedback: 1,
      skippedBelowThreshold: 0,
      skippedUnchanged: 0,
  });
  assert.deepEqual(decisions, [
    {
      cardId: "card_1",
      intentKey: "work:draft-hiring-outreach",
      goalBasket: "work",
      decision: "refine",
      summary: "User kept drilling into the executable hiring follow-up.",
      nextAngles: ["draft outreach", "schedule follow-up"],
    },
  ]);
});

test("syncCardChatFeedback skips unchanged transcripts", async () => {
  const transcript = [
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: 'The user opened "Draft hiring outreach". Suggested action: "Draft outreach". Confirm details briefly, then execute.' },
    { role: "assistant", content: "I can help with that." },
    { role: "user", content: "Can you draft the hiring outreach email?" },
    { role: "assistant", content: "Yes — I can draft it and propose recipients." },
    { role: "user", content: "Also help me decide who should get the first pass today." },
    { role: "assistant", content: "We can prioritize the warm leads first." },
    { role: "user", content: "Great, and suggest a follow-up cadence I can use." },
  ];
  const normalized = normalizeCardChatMessages(transcript);
  let summarized = false;

  const result = await syncCardChatFeedback(
    {
      api: {} as never,
      trigger: "manual",
    },
    {
      listRecentGeneratedCards: async () => [
        {
          cardId: "card_1",
          goalBasket: "work",
          title: "Draft hiring outreach",
          titleKey: "draft-hiring-outreach",
          generatedAt: "2026-04-12T01:00:00.000Z",
        },
      ],
      listFeedback: async () => [
        {
          metadata: {
            analysisType: CARD_CHAT_INTEREST_ANALYSIS_TYPE,
            transcriptHash: hashNormalizedCardChatMessages(normalized),
          },
        },
      ],
      getSessionMessages: async () => transcript,
      summarizeEligibleChats: async () => {
        summarized = true;
        return { signals: [] };
      },
      logFeedback: async () => {
        throw new Error("should not write feedback");
      },
    },
  );

  assert.equal(summarized, false);
  assert.deepEqual(result, {
    scannedCards: 1,
    qualifiedCards: 1,
    summarizedCards: 0,
    writtenFeedback: 0,
    skippedBelowThreshold: 0,
    skippedUnchanged: 1,
  });
});
