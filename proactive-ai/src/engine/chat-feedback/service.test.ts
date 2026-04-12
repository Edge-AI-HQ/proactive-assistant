import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreContext } from "../../core/index.js";
import { buildChatFirstMessage } from "../agents/chat.js";

const { listRecentGeneratedCards, listFeedback, logFeedback } = vi.hoisted(() => ({
  listRecentGeneratedCards: vi.fn(),
  listFeedback: vi.fn(),
  logFeedback: vi.fn(),
}));

vi.mock("../../core/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/index.js")>("../../core/index.js");
  return {
    ...actual,
    cards: {
      ...actual.cards,
      listRecentGeneratedCards,
    },
    feedback: {
      ...actual.feedback,
      listFeedback,
      logFeedback,
    },
  };
});

import {
  CARD_CHAT_INTEREST_ANALYSIS_TYPE,
  getCardChatSessionKey,
  hashNormalizedCardChatMessages,
  normalizeCardChatMessages,
  syncCardChatFeedback,
} from "./service.js";

function createCtx(): CoreContext {
  return {
    env: {},
    homeDir: "/tmp",
  };
}

function createApi(summaryJson?: string) {
  const output = summaryJson ?? `\`\`\`json
{
  "signals": [
    {
      "cardId": "card_1",
      "summary": "User kept drilling into the executable hiring follow-up.",
      "interestScore": 0.86,
      "topics": ["hiring", "follow-up"],
      "nextAngles": ["draft outreach", "schedule follow-up"]
    }
  ]
}
\`\`\``;

  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      subagent: {
        getSessionMessages: vi.fn()
          .mockResolvedValueOnce({
            messages: [
              { role: "assistant", content: "I can help with that." },
              { role: "user", content: buildChatFirstMessage() },
              { role: "assistant", content: "I can help with that." },
              { role: "user", content: "Can you draft the hiring outreach email?" },
              { role: "assistant", content: "Yes — I can draft it and propose recipients." },
              { role: "user", content: "Also help me decide who should get the first pass today." },
              { role: "assistant", content: "We can prioritize the warm leads first." },
              { role: "user", content: "Great, and suggest a follow-up cadence I can use." },
            ],
          })
          .mockResolvedValueOnce({
            messages: [
              { role: "assistant", content: output },
            ],
          }),
        run: vi.fn().mockResolvedValue({ runId: "chat-feedback-run-1" }),
        waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

describe("normalizeCardChatMessages", () => {
  it("filters the synthetic first-turn user prompt and duplicate assistant replies", () => {
    const messages = normalizeCardChatMessages([
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: buildChatFirstMessage() },
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: "Can you draft the outreach?" },
      { role: "assistant", content: [{ type: "text", text: "Yes — I'll draft it." }] },
    ]);

    expect(messages).toEqual([
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: "Can you draft the outreach?" },
      { role: "assistant", content: "Yes — I'll draft it." },
    ]);
  });
});

describe("syncCardChatFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("summarizes qualified changed card chats into agent_analysis feedback rows", async () => {
    listRecentGeneratedCards.mockResolvedValue([
      {
        cardId: "card_1",
        goalBasket: "work",
        title: "Draft hiring outreach",
        titleKey: "draft-hiring-outreach",
        generatedAt: "2026-04-12T01:00:00.000Z",
      },
    ]);
    listFeedback.mockResolvedValue([]);
    logFeedback.mockResolvedValue({ id: "fe_1" });
    const api = createApi();

    const result = await syncCardChatFeedback({
      ctx: createCtx(),
      api: api as never,
      trigger: "manual",
    });

    const normalizedMessages = normalizeCardChatMessages([
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: buildChatFirstMessage() },
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: "Can you draft the hiring outreach email?" },
      { role: "assistant", content: "Yes — I can draft it and propose recipients." },
      { role: "user", content: "Also help me decide who should get the first pass today." },
      { role: "assistant", content: "We can prioritize the warm leads first." },
      { role: "user", content: "Great, and suggest a follow-up cadence I can use." },
    ]);

    expect(logFeedback).toHaveBeenCalledWith(
      createCtx(),
      expect.objectContaining({
        kind: "text_feedback",
        source: "agent_analysis",
        intentCardId: "card_1",
        conversationId: getCardChatSessionKey("card_1"),
        basket: "work",
        channel: "web",
        text: "User kept drilling into the executable hiring follow-up.",
        metadata: expect.objectContaining({
          analysisType: CARD_CHAT_INTEREST_ANALYSIS_TYPE,
          titleKey: "draft-hiring-outreach",
          transcriptHash: hashNormalizedCardChatMessages(normalizedMessages),
          messageCount: normalizedMessages.length,
          userTurns: 3,
          interestScore: 0.86,
          topics: ["hiring", "follow-up"],
          nextAngles: ["draft outreach", "schedule follow-up"],
        }),
      }),
    );
    expect(result).toEqual({
      scannedCards: 1,
      qualifiedCards: 1,
      summarizedCards: 1,
      writtenFeedback: 1,
      skippedBelowThreshold: 0,
      skippedUnchanged: 0,
    });
  });

  it("skips summarization when the latest stored transcript hash is unchanged", async () => {
    listRecentGeneratedCards.mockResolvedValue([
      {
        cardId: "card_1",
        goalBasket: "work",
        title: "Draft hiring outreach",
        titleKey: "draft-hiring-outreach",
        generatedAt: "2026-04-12T01:00:00.000Z",
      },
    ]);

    const normalizedMessages = normalizeCardChatMessages([
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: buildChatFirstMessage() },
      { role: "assistant", content: "I can help with that." },
      { role: "user", content: "Can you draft the hiring outreach email?" },
      { role: "assistant", content: "Yes — I can draft it and propose recipients." },
      { role: "user", content: "Also help me decide who should get the first pass today." },
      { role: "assistant", content: "We can prioritize the warm leads first." },
      { role: "user", content: "Great, and suggest a follow-up cadence I can use." },
    ]);

    listFeedback.mockResolvedValue([
      {
        metadata: {
          analysisType: CARD_CHAT_INTEREST_ANALYSIS_TYPE,
          transcriptHash: hashNormalizedCardChatMessages(normalizedMessages),
        },
      },
    ]);
    const api = createApi();

    const result = await syncCardChatFeedback({
      ctx: createCtx(),
      api: api as never,
      trigger: "manual",
    });

    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    expect(logFeedback).not.toHaveBeenCalled();
    expect(result).toEqual({
      scannedCards: 1,
      qualifiedCards: 1,
      summarizedCards: 0,
      writtenFeedback: 0,
      skippedBelowThreshold: 0,
      skippedUnchanged: 1,
    });
  });
});
