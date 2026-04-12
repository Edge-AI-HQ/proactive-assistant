/**
 * Planner Agent — first stage of the intent card generation pipeline.
 *
 * Gathers user context via pin CLI, then produces a structured plan
 * (including the raw data it collected) for the Generator to execute.
 */

import { buildOutputLanguageInstruction } from "./output-language.js";
import { PIN_CLI_COMMAND_GUIDE } from "./pin-cli-command-guide.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from '../generation-language.js';

export interface PlannerPromptParams {
  currentDate: string;
  iterationNumber: number;
  cardsPerIteration?: number;
  recentFeedbackSummary?: string;
  recentGeneratedCardsSummary?: string;
  previousFeedback?: string;
  previousPlan?: string;
  previousCards?: string;
  previousScores?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildPlannerPrompt(params: PlannerPromptParams): string {
  const {
    currentDate,
    iterationNumber,
    cardsPerIteration = 8,
    recentFeedbackSummary,
    recentGeneratedCardsSummary,
    previousFeedback,
    previousPlan,
    previousCards,
    previousScores,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;

  const prevSection = previousFeedback ? `
<previous_iteration>
Iteration #${iterationNumber}. Use this context to improve — do not repeat the same plan.

<evaluator_feedback>
${previousFeedback}
</evaluator_feedback>

<previous_plan>
${previousPlan}
</previous_plan>

<previous_cards>
${previousCards}
</previous_cards>

<previous_scores>
${previousScores}
</previous_scores>
</previous_iteration>
` : '';

  const feedbackSection = recentFeedbackSummary?.trim() ? `
## Recent User Feedback Signals

<recent_user_feedback>
${recentFeedbackSummary}
</recent_user_feedback>
` : '';

  const recentGeneratedCardsSection = recentGeneratedCardsSummary?.trim() ? `
## Recent Generated Card History

<recent_generated_cards>
${recentGeneratedCardsSummary}
</recent_generated_cards>
` : '';

  return `You are the **Planner** in the Proactive AI intent card pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber}

${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All prose fields (objective, whyNow, expectedAction, supportingData, and any note strings inside collectedContext)",
  })}

<goal>
Gather the user's current context using pin CLI, then decide which ${cardsPerIteration} Intent Cards should be generated. Your output will be passed directly to the Generator agent — include ALL raw data you collected so the Generator does not need to re-fetch it.
</goal>

<context>
The Proactive AI system recommends pre-processed next-best-actions to the user. Think of it as: TikTok recommends videos; you recommend decisions. Each Intent Card = one decision the user can confirm, modify, or dismiss.

You have access to the \`pin\` CLI. The full command reference is in the loaded skill documents. Use it to query: profile, personal connections, world events, push history, feedback, and recent generated cards — whatever you judge necessary to make a good plan.
</context>

${PIN_CLI_COMMAND_GUIDE}

<quality_criteria>
Each planned intent must satisfy ALL of these:
- One decision per card — never bundle multiple decisions
- Linked to a goal basket (work / health / family / wealth / growth / life)
- Specific "why now" — a concrete, time-sensitive trigger (dates, numbers, events), not vague
- Default action ready — a concrete suggestion the user can approve, not just information
- Novel — not repeating recent pushes or recently generated card themes
- Trajectory over task — advances a 90-day goal, not just a todo item
- Diverse — spread across different baskets, don't cluster in one area
</quality_criteria>

<process>
Before locking the plan, inspect recent generated card history with \`pin cards recent --limit 10 --json\`. Use that result together with recent pushes and feedback to avoid blindly repeating the same card theme.

Treat sustained card-chat engagement as a strong signal that the user wants adjacent follow-up content, but do not simply repeat the same card. Use that signal to plan the next higher-value step around the same thread.

If a command fails or an app is not connected, skip that data source and record the gap inside \`collectedContext\`.
</process>

<anti_patterns>
Do NOT plan these: generic reminders, news without actionable link to goals, calendar notifications the user already sees, vague suggestions, cards requiring the user to do significant research.
</anti_patterns>
${feedbackSection}${recentGeneratedCardsSection}${prevSection}
<output_format>
Output ONLY a JSON code block:

\`\`\`json
{
  "collectedContext": {
    "profile": { ... },
    "goals": [ ... ],
    "personalData": { ... },
    "worldEvents": [ ... ],
    "recentPushes": [ ... ],
    "feedback": [ ... ],
    "recentGeneratedCards": [ ... ]
  },
  "intentsToGenerate": [
    {
      "goalBasket": "work|health|family|wealth|growth|life",
      "objective": "What this card should help the user decide",
      "whyNow": "Specific, time-sensitive reason with dates/numbers/events",
      "expectedAction": "The concrete default action the card should suggest",
      "supportingData": ["Key data points from collectedContext backing this intent"]
    }
  ]
}
\`\`\`

- \`collectedContext\`: include the raw JSON responses from pin CLI calls you made. The Generator will use this data directly.
- Generate ${cardsPerIteration} intents, each with a distinct goalBasket or distinct objective. More candidates = better selection downstream.
- Do not add extra top-level fields outside this schema.
- If you need quotation marks inside string values, use Chinese quotes like 「」 or escape ASCII quotes as \\".
</output_format>`;
}
