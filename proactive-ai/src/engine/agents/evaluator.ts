/**
 * Evaluator Agent — third stage of the intent card generation pipeline.
 *
 * Scores generated Intent Cards on 5 quality dimensions, selects the best
 * cards, and provides actionable feedback for the next iteration.
 */

import { buildOutputLanguageInstruction } from "./output-language.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from '../generation-language.js';

export interface EvaluatorPromptParams {
  currentDate: string;
  plan: string;              // JSON string of PlannerOutput
  cards: string;             // JSON string of GeneratorOutput
  iterationNumber: number;
  maxIterations: number;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildEvaluatorPrompt(params: EvaluatorPromptParams): string {
  const {
    currentDate,
    plan,
    cards,
    iterationNumber,
    maxIterations,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;
  const isLastIteration = iterationNumber >= maxIterations;

  return `You are the **Evaluator** in the Proactive AI intent card pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber} of ${maxIterations}

${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All text fields (feedback, iterationFeedback, etc.)",
  })}

<goal>
Critically evaluate the generated Intent Cards. You are the quality gate. A mediocre card erodes user trust — it is worse than no card.

You have access to the \`pin\` CLI (command reference in loaded skill documents) if you need to verify any data claims. Use your judgment on whether verification is warranted.
</goal>

<plan>
${plan}
</plan>

<generated_cards>
${cards}
</generated_cards>

<scoring_rubric>
Score each card on 5 dimensions (0.0–10.0):

**Relevance** — Does this connect to a real user goal?
  0–3: No clear connection | 4–6: Loosely related | 7–8: Clearly relevant | 9–10: Hits a critical goal

**Actionability** — Can the user act immediately?
  0–3: Informational only | 4–6: Vague action | 7–8: Specific with clear steps | 9–10: One-click executable

**Why Now Clarity** — Is timing specific and compelling?
  0–3: Could be shown anytime | 4–6: Vague urgency | 7–8: Specific trigger with dates/events | 9–10: Miss this window and opportunity is lost

**Novelty** — Is this new information for the user?
  0–3: Already known or recently pushed | 4–6: New angle on known topic | 7–8: Genuinely new | 9–10: Surprising cross-domain insight

**Decision Compression** — How much thinking does this save?
  0–3: User still needs to research | 4–6: Some context, user does most thinking | 7–8: Most thinking done | 9–10: Complete decision package

Pass threshold: overall (average of 5 dimensions) >= 5.0. Be strict — do not inflate scores.
</scoring_rubric>

<feedback_instructions>
${isLastIteration
    ? `This is the **final iteration**. No more improvement cycles. Focus on selecting the best cards from this batch.`
    : `Your feedback will be fed to the Planner and Generator for iteration ${iterationNumber + 1}. Be specific and constructive: what should change, which cards to drop, what new cards to attempt, what data was missing.`
}
</feedback_instructions>

<output_format>
Output ONLY a JSON code block:

\`\`\`json
{
  "evaluations": [
    {
      "cardId": "card_1_1",
      "overall": 7.8,
      "dimensions": {
        "relevance": 8.5,
        "actionability": 7.0,
        "whyNowClarity": 8.0,
        "novelty": 7.5,
        "decisionCompression": 8.0
      },
      "feedback": "Specific improvement suggestions for this card",
      "pass": true
    }
  ],
  "bestCards": [],
  "iterationFeedback": "Overall feedback for the next iteration."
}
\`\`\`

- Evaluate EVERY card.
- overall = average of 5 dimensions (calculate correctly).
- pass = true only if overall >= 5.0.
- bestCards: full IntentCard objects that passed, sorted by overall score descending.
- iterationFeedback: actionable and specific.
</output_format>`;
}
