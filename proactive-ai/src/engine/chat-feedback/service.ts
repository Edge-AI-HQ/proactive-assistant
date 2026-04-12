import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { cards, feedback, type CoreContext } from "../../core/index.js";
import { buildChatFirstMessage } from "../agents/chat.js";
import { extractTextContent } from "../helpers.js";
import {
  detectAgentErrorInMessages,
  parseAgentJson,
} from "../pipeline/agent-output.js";
import { makeIntentKey, makeTitleKey } from "../../shared/intent-key.js";

export const CARD_CHAT_INTEREST_ANALYSIS_TYPE = "card_chat_interest";

const DEFAULT_LOOKBACK = "14d";
const DEFAULT_CARD_LIMIT = 40;
const DEFAULT_SESSION_MESSAGE_LIMIT = 50;
const MIN_USER_TURNS = 2;
const MIN_TOTAL_MESSAGES = 6;
const MIN_USER_TEXT_CHARS = 120;
const CHAT_FEEDBACK_TIMEOUT_MS = 60_000;

interface GeneratedCardRecord {
  cardId?: string | null;
  goalBasket?: string | null;
  title?: string | null;
  titleKey?: string | null;
  generatedAt?: string | null;
}

interface FeedbackRecordLike {
  metadata?: Record<string, unknown> | null;
}

export interface NormalizedCardChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface EligibleCardChat {
  cardId: string;
  goalBasket: string;
  title: string;
  titleKey: string;
  sessionKey: string;
  generatedAt: string | null;
  messages: NormalizedCardChatMessage[];
  transcriptHash: string;
  userTurns: number;
  messageCount: number;
  userTextChars: number;
}

interface ChatFeedbackSignal {
  cardId?: string;
  summary?: string;
  interestScore?: number;
  topics?: string[];
  nextAngles?: string[];
}

interface ChatFeedbackSynthesis {
  signals?: ChatFeedbackSignal[];
}

export interface SyncCardChatFeedbackResult {
  scannedCards: number;
  qualifiedCards: number;
  summarizedCards: number;
  writtenFeedback: number;
  skippedBelowThreshold: number;
  skippedUnchanged: number;
}

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
    : [];

function extractAssistantText(messages: unknown[]): string {
  const assistantMessages = (messages as Array<{ role?: string; content?: unknown }>)
    .filter((message) => message.role === "assistant");
  const last = assistantMessages[assistantMessages.length - 1];
  return last?.content ? extractTextContent(last.content) : "";
}

function countUserTurns(messages: NormalizedCardChatMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function countUserTextChars(messages: NormalizedCardChatMessage[]): number {
  return messages
    .filter((message) => message.role === "user")
    .reduce((sum, message) => sum + message.content.length, 0);
}

function buildSummarizerPrompt(chats: EligibleCardChat[]): string {
  return `You are summarizing user engagement across proactive intent-card chat sessions.

Return ONLY a JSON code block with this shape:

\`\`\`json
{
  "signals": [
    {
      "cardId": "card id",
      "summary": "One concise sentence about what the user cared about in this card chat",
      "interestScore": 0.0,
      "topics": ["topic1", "topic2"],
      "nextAngles": ["follow-up angle 1", "follow-up angle 2"]
    }
  ]
}
\`\`\`

Rules:
- Only summarize the cards included in the input.
- Focus on durable interest, preferred follow-up angles, and what should bias future card generation.
- Do not repeat raw transcript text unless absolutely necessary.
- Do not include secrets, codes, or long quotes.
- Keep topics and nextAngles short.

<card_chats>
${JSON.stringify(chats, null, 2)}
</card_chats>`;
}

async function runChatFeedbackSummarizer(
  api: OpenClawPluginApi,
  chats: EligibleCardChat[],
): Promise<ChatFeedbackSynthesis> {
  if (!api.runtime?.subagent) {
    throw new Error("Card chat feedback requires runtime subagent");
  }

  const sessionKey = `agent:main:proactive-ai:chat-feedback:${Date.now().toString(36)}`;
  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: buildSummarizerPrompt(chats),
    idempotencyKey: `proactive-ai:chat-feedback:${Date.now().toString(36)}`,
    message: "Summarize the qualifying card chats and return the required JSON.",
    deliver: false,
  });

  try {
    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: CHAT_FEEDBACK_TIMEOUT_MS,
    });
    if (result.status !== "ok") {
      throw new Error(`Card chat feedback summarizer failed with status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
    }

    const messages = await api.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: 10,
    });
    const messageError = detectAgentErrorInMessages(messages.messages);
    if (messageError) {
      throw new Error(`Card chat feedback summarizer failed: ${messageError}`);
    }

    const parsed = parseAgentJson<ChatFeedbackSynthesis>(
      extractAssistantText(messages.messages),
    );
    if (!parsed) {
      throw new Error("Card chat feedback summarizer returned invalid JSON");
    }
    return parsed;
  } finally {
    await api.runtime.subagent.deleteSession({
      sessionKey,
      deleteTranscript: false,
    }).catch(() => {});
  }
}

async function findLatestTranscriptHash(
  ctx: CoreContext,
  cardId: string,
): Promise<string | null> {
  const rows = await feedback.listFeedback(ctx, {
    source: "agent_analysis",
    intentCardId: cardId,
    limit: "5",
  }) as FeedbackRecordLike[];

  for (const row of rows) {
    const metadata = row.metadata ?? {};
    if (metadata["analysisType"] !== CARD_CHAT_INTEREST_ANALYSIS_TYPE) continue;
    const transcriptHash = asTrimmedString(metadata["transcriptHash"]);
    if (transcriptHash) return transcriptHash;
  }

  return null;
}

export function getCardChatSessionKey(cardId: string): string {
  return `agent:main:proactive-ai:chat:card:${cardId}`;
}

export function normalizeCardChatMessages(messages: unknown[]): NormalizedCardChatMessage[] {
  const firstTurnPrompt = buildChatFirstMessage();
  const seenAssistant = new Set<string>();

  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: extractTextContent(message.content),
    }))
    .filter((message) => {
      if (!message.content) return false;
      if (message.role === "user" && message.content.includes(firstTurnPrompt)) {
        return false;
      }
      if (message.role === "assistant") {
        if (seenAssistant.has(message.content)) return false;
        seenAssistant.add(message.content);
      }
      return true;
    });
}

export function hashNormalizedCardChatMessages(
  messages: NormalizedCardChatMessage[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex");
}

export async function syncCardChatFeedback(input: {
  ctx: CoreContext;
  api: OpenClawPluginApi;
  trigger: "manual" | "auto" | "pre_generate";
  since?: string;
  limit?: number;
}): Promise<SyncCardChatFeedbackResult> {
  const rows = await cards.listRecentGeneratedCards(input.ctx, {
    since: input.since ?? DEFAULT_LOOKBACK,
    limit: String(input.limit ?? DEFAULT_CARD_LIMIT),
  }) as GeneratedCardRecord[];

  const result: SyncCardChatFeedbackResult = {
    scannedCards: rows.length,
    qualifiedCards: 0,
    summarizedCards: 0,
    writtenFeedback: 0,
    skippedBelowThreshold: 0,
    skippedUnchanged: 0,
  };

  const eligible: EligibleCardChat[] = [];

  for (const row of rows) {
    const cardId = asTrimmedString(row.cardId);
    const goalBasket = asTrimmedString(row.goalBasket);
    const title = asTrimmedString(row.title);
    const titleKey = asTrimmedString(row.titleKey);

    if (!cardId || !goalBasket || !title) continue;

    let rawMessages: unknown[] = [];
    try {
      const session = await input.api.runtime.subagent.getSessionMessages({
        sessionKey: getCardChatSessionKey(cardId),
        limit: DEFAULT_SESSION_MESSAGE_LIMIT,
      });
      rawMessages = Array.isArray(session.messages) ? session.messages : [];
    } catch {
      continue;
    }

    const messages = normalizeCardChatMessages(rawMessages);
    if (messages.length === 0) continue;

    const userTurns = countUserTurns(messages);
    const messageCount = messages.length;
    const userTextChars = countUserTextChars(messages);
    const qualifies = userTurns >= MIN_USER_TURNS
      && (messageCount >= MIN_TOTAL_MESSAGES || userTextChars >= MIN_USER_TEXT_CHARS);

    if (!qualifies) {
      result.skippedBelowThreshold += 1;
      continue;
    }

    result.qualifiedCards += 1;
    const transcriptHash = hashNormalizedCardChatMessages(messages);
    const previousHash = await findLatestTranscriptHash(input.ctx, cardId);
    if (previousHash === transcriptHash) {
      result.skippedUnchanged += 1;
      continue;
    }

    eligible.push({
      cardId,
      goalBasket,
      title,
      titleKey: titleKey ?? makeTitleKey(title),
      sessionKey: getCardChatSessionKey(cardId),
      generatedAt: asTrimmedString(row.generatedAt),
      messages,
      transcriptHash,
      userTurns,
      messageCount,
      userTextChars,
    });
  }

  if (eligible.length === 0) {
    return result;
  }

  const synthesis = await runChatFeedbackSummarizer(input.api, eligible);
  const signals = Array.isArray(synthesis.signals) ? synthesis.signals : [];

  for (const signal of signals) {
    const cardId = asTrimmedString(signal.cardId);
    const summary = asTrimmedString(signal.summary);
    if (!cardId || !summary) continue;

    const match = eligible.find((item) => item.cardId === cardId);
    if (!match) continue;

    await feedback.logFeedback(input.ctx, {
      kind: "text_feedback",
      source: "agent_analysis",
      intentCardId: match.cardId,
      conversationId: match.sessionKey,
      basket: match.goalBasket,
      channel: "web",
      text: summary,
      metadata: {
        analysisType: CARD_CHAT_INTEREST_ANALYSIS_TYPE,
        intentKey: makeIntentKey(match.goalBasket, match.title),
        titleKey: match.titleKey,
        title: match.title,
        generatedAt: match.generatedAt,
        transcriptHash: match.transcriptHash,
        messageCount: match.messageCount,
        userTurns: match.userTurns,
        userTextChars: match.userTextChars,
        interestScore: typeof signal.interestScore === "number" ? signal.interestScore : undefined,
        topics: asStringArray(signal.topics),
        nextAngles: asStringArray(signal.nextAngles),
        trigger: input.trigger,
      },
    });

    result.writtenFeedback += 1;
  }

  result.summarizedCards = result.writtenFeedback;
  return result;
}
