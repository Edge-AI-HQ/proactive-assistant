/**
 * Chat Agent prompt builder — chat-driven tool use over the pin CLI +
 * browser + pin web fetch. Tier 1-4 policy is baked into the stable
 * prefix so the agent makes the right tool choice without per-call
 * re-litigation.
 *
 * Cache layout (deliberate):
 *   stable prefix · OPENCLAW_CACHE_BOUNDARY · volatile suffix
 *   ──────────────                          ───────────────
 *   role / output language / Tier 1-4       card_context JSON
 *   table / routing examples / side-        learned-skills section
 *   effect rules / output style             (anything per-invocation)
 *
 * Anything per-invocation goes AFTER the boundary marker so the prefix
 * stays cacheable. The chat.test.ts cache-boundary assertions enforce
 * this — adding card-specific text into the prefix will fail tests.
 */
import { buildOutputLanguageInstruction } from './output-language.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from './generation-language.js';
import {
  renderRoutingExamplesBlock,
  renderSideEffectRulesBlock,
  renderToolDecisionPolicyBlock,
} from '../execution-policy.js';

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
  /**
   * Source identifiers from generation. Format `<source_kind>:[<metadata>] '<quoted>'`
   * (e.g. `gmail:thread_id=...`, `raw:gcal:event_id=...`, `memory:topic:...`,
   * `world:...`). The first-message hint uses these to point the agent at
   * the matching pin Tier 1/2 path immediately.
   */
  sources?: string[];
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

/**
 * Sentinel that splits the cacheable prefix from the per-invocation
 * suffix. Exported so tests can assert prefix stability.
 */
export const OPENCLAW_CACHE_BOUNDARY = '<!-- OPENCLAW_CACHE_BOUNDARY -->';

/* ------------------------------------------------------------------ */
/*  Stable prefix sections                                             */
/* ------------------------------------------------------------------ */

const TIER_POLICY_BLOCK = `<tool_decision_policy>\n${renderToolDecisionPolicyBlock()}\n</tool_decision_policy>`;

const ROUTING_EXAMPLES_BLOCK = `<routing_examples>\n${renderRoutingExamplesBlock()}\n</routing_examples>`;

const SIDE_EFFECT_RULES_BLOCK = `<side_effect_rules>\n${renderSideEffectRulesBlock()}\n</side_effect_rules>`;

const OUTPUT_STYLE_BLOCK = `<output_style>
- Be specific: "I'll pull that thread from Gmail right now" — not "I can help
  with email-related tasks".
- One reply per turn, after all tool calls finish. Do not emit a pre-tool ack
  ("好的,让我看一下…") and a post-tool recap ("看到了!") in the same turn —
  one reply, at the end.
- Keep replies to 3-5 sentences unless the user asks for more.
- If something is beyond your tools, suggest a concrete workaround instead of
  saying "I can't".
</output_style>`;

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

  // ── Stable prefix (cacheable) ────────────────────────────────────
  const stablePrefix: string[] = [
    'You are the **Chat** agent in the Proactive AI system.',
    buildOutputLanguageInstruction(outputLanguage, {
      fieldsDescription: 'All reply text',
    }),
    TIER_POLICY_BLOCK,
    ROUTING_EXAMPLES_BLOCK,
    SIDE_EFFECT_RULES_BLOCK,
    OUTPUT_STYLE_BLOCK,
  ];

  // ── Volatile suffix (per-invocation) ─────────────────────────────
  const volatileSuffix: string[] = [];
  const cardBlock = card
    ? JSON.stringify(card, null, 2)
    : rawCardContext;
  if (cardBlock) {
    volatileSuffix.push(`<card_context>\n${cardBlock}\n</card_context>`);
  }
  if (learnedSkillsSection && learnedSkillsSection.trim().length > 0) {
    volatileSuffix.push(learnedSkillsSection.trim());
  }

  const systemPrompt = [
    ...stablePrefix,
    OPENCLAW_CACHE_BOUNDARY,
    ...volatileSuffix,
  ].join('\n\n');

  const firstMessage = buildFirstMessage(card, rawCardContext);
  return { systemPrompt, firstMessage };
}

/* ------------------------------------------------------------------ */
/*  First-message strategy                                             */
/* ------------------------------------------------------------------ */

function buildFirstMessage(
  card: ChatCardContext | undefined,
  rawCardContext: string | undefined,
): string {
  if (!card && !rawCardContext) return '';
  if (!card) {
    return 'The user opened an intent card. Greet briefly and suggest what you can do based on the card context.';
  }

  const { primaryAction, urgency = 0, title } = card;
  const sourceHint = sourceKindHint(card.sources);

  if (urgency >= 0.7 && primaryAction.type === 'confirm') {
    return `The user opened "${title}" and wants to proceed. Execute: "${primaryAction.label}". If anything is ambiguous, ask one question.${sourceHint}`;
  }
  if (primaryAction.type === 'confirm') {
    return `The user opened "${title}". Suggested action: "${primaryAction.label}". Confirm details briefly, then execute.${sourceHint}`;
  }
  return `The user opened "${title}". Help them with: ${card.summary}${sourceHint}`;
}

/**
 * Pull source_kind tokens out of `sources` and turn them into a one-line
 * Tier 1/2 routing hint so the first agent step lands on the right pin
 * subcommand instead of guessing. Returns "" when sources are absent.
 */
function sourceKindHint(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) return '';
  const kinds = Array.from(new Set(
    sources
      .map((s) => s.split(':')[0]?.trim())
      .filter((k): k is string => Boolean(k)),
  ));
  if (kinds.length === 0) return '';
  return ` Sources: ${kinds.join(', ')}. Start with the matching pin path (e.g. \`pin raw gmail\` for gmail, \`pin raw gcal\` for gcal, \`pin memory search\` for memory, \`pin world\` for world).`;
}
