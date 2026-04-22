/**
 * Chat Agent prompt builder — conversational follow-up on intent cards.
 *
 * When the user taps on an intent card, this agent builds the system prompt
 * and first message based on the card's structure (urgency, primaryAction type).
 * For plain chat (no card), it provides a minimal system prompt with no injected
 * first message.
 *
 * Pattern: same as planner.ts / generator.ts / evaluator.ts —
 *   Params interface  +  build function  +  outputLanguage support.
 */
import { buildOutputLanguageInstruction } from './output-language.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from './generation-language.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Structured card context — subset of Generator output schema. */
export interface ChatCardContext {
  title: string;
  summary: string;
  primaryAction: { label: string; type: string };
  secondaryActions?: { label: string; type: string }[];
  urgency?: number;
  goalBasket?: string;
}

export interface ChatPromptParams {
  card?: ChatCardContext;
  /** Fallback when frontend sends an unstructured string. */
  rawCardContext?: string;
  outputLanguage?: SupportedGenerationLanguage;
  /**
   * Pre-formatted markdown section describing active learned skills.
   * Produced by `conversation-crystallize/skill-injection.ts`. Omitted when
   * empty.
   */
  learnedSkillsSection?: string;
}

export interface ChatPromptResult {
  systemPrompt: string;
  /** Empty string = plain chat, no injected first message. */
  firstMessage: string;
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

export function buildChatPrompt(params: ChatPromptParams): ChatPromptResult {
  const {
    card,
    rawCardContext,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
    learnedSkillsSection,
  } = params;

  // ── system prompt ──
  const sections: string[] = [
    'You are the **Chat** agent in the Proactive AI system.',
    buildOutputLanguageInstruction(outputLanguage, {
      fieldsDescription: 'All reply text',
    }),
  ];

  // card context (structured first, raw fallback)
  const cardBlock = card
    ? JSON.stringify(card, null, 2)
    : rawCardContext;
  if (cardBlock) {
    sections.push(`<card_context>\n${cardBlock}\n</card_context>`);
  }

  if (learnedSkillsSection && learnedSkillsSection.trim().length > 0) {
    sections.push(learnedSkillsSection.trim());
  }

  // interaction style — static; pin CLI reference lives in loaded skill docs
  sections.push(`<instructions>
You have access to the \`pin\` CLI. The full command reference is in the loaded skill documents.

- Be specific: "I'll pull up that email from Gmail right now" not "I can help you with email-related tasks."
- When the user confirms, execute immediately. Don't ask for permission twice.
- Always prefer pin CLI over telling the user to do things manually.
- If something is beyond your current tools, suggest a concrete workaround.
- Respond ONCE per turn, AFTER all tool calls finish. Do NOT emit a pre-tool acknowledgement ("好的,让我记下来...") and a post-tool recap ("记住了!") in the same turn — one reply, at the end.
- Keep replies to 3-5 sentences.
</instructions>`);

  // ── first message ──
  const firstMessage = buildFirstMessage(card, rawCardContext);

  return { systemPrompt: sections.join('\n\n'), firstMessage };
}

/* ------------------------------------------------------------------ */
/*  First-message strategy                                             */
/* ------------------------------------------------------------------ */

function buildFirstMessage(
  card: ChatCardContext | undefined,
  rawCardContext: string | undefined,
): string {
  // plain chat — no injection
  if (!card && !rawCardContext) return '';

  // raw string only — generic fallback
  if (!card) {
    return 'The user opened an intent card. Greet briefly and suggest what you can do based on the card context.';
  }

  const { primaryAction, urgency = 0, title } = card;

  // high urgency + confirm → execute immediately
  if (urgency >= 0.7 && primaryAction.type === 'confirm') {
    return `The user opened "${title}" and wants to proceed. Execute: "${primaryAction.label}". If anything is ambiguous, ask one question.`;
  }

  // confirm + lower urgency → confirm then execute
  if (primaryAction.type === 'confirm') {
    return `The user opened "${title}". Suggested action: "${primaryAction.label}". Confirm details briefly, then execute.`;
  }

  // modify / other → conversational exploration
  return `The user opened "${title}". Help them with: ${card.summary}`;
}
