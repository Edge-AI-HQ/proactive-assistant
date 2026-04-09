import { buildOutputLanguageInstruction } from "./output-language.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from "../generation-language.js";

export interface PlannerPromptParams {
  currentDate: string;
  iterationNumber: number;
  contextBrief: string;
  recentFeedbackSummary?: string;
  previousIterationDelta?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildPlannerPrompt(params: PlannerPromptParams): string {
  const {
    currentDate,
    iterationNumber,
    contextBrief,
    recentFeedbackSummary,
    previousIterationDelta,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;

  const feedbackSection = recentFeedbackSummary?.trim()
    ? `\n## Recent User Feedback Signals

${recentFeedbackSummary}
`
    : "";

  const deltaSection = previousIterationDelta?.trim()
    ? `\n## Previous Iteration Delta

\`\`\`json
${previousIterationDelta}
\`\`\`
`
    : "";

  return `You are the Planner Agent in a Proactive AI pipeline that generates intent cards — pre-processed next-best-actions for the user.
Today: ${currentDate} | Iteration: ${iterationNumber}

<language_requirement>
${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All prose fields (reasoning, objective, whyNow, expectedAction, contextGaps, etc.)",
  })}
</language_requirement>

<context_brief>
${contextBrief}
</context_brief>
${feedbackSection ? `\n<recent_feedback>\n${recentFeedbackSummary}\n</recent_feedback>` : ""}
${deltaSection ? `\n<previous_iteration_delta>\n${previousIterationDelta}\n</previous_iteration_delta>` : ""}
<evidence_vocabulary>
Available evidence domains (use in evidenceRefs):
profile.profile, profile.facts, profile.goals, profile.preferences, profile.constraints, profile.snapshot,
personal.status, personal.connections, recent.push, recent.feedback,
world.shortlist, incremental.world, incremental.personal
</evidence_vocabulary>

<instructions>
Your job: read the context brief above and produce a plan of 3-5 intent cards worth generating this iteration.

For each intent, identify:
1. The single decision it helps the user make (one intent = one decision, because bundled actions confuse the user and reduce card actionability)
2. A concrete "why now" trigger tied to a specific date, change, or fresh signal (vague urgency erodes user trust)
3. The exact evidenceRefs the Generator should cite (so the Generator stays evidence-bound rather than hallucinating)
4. Any context gaps that block a stronger card (surfacing gaps is better than inventing facts)

Prioritize intents at the intersection of:
- goals × recent personal signals
- goals × recent world signals
- constraints × timing windows

Spread intents across goal baskets when evidence supports it — clustering into one basket wastes the user's attention budget.

Do not request tool calls or broad discovery. All context you need is in the brief above.
</instructions>

<output_format>
Respond with ONLY a JSON code block:

\`\`\`json
{
  "reasoning": "Which context areas matter most and why these intents are the best use of this iteration.",
  "contextGaps": ["Missing context that limits stronger planning, if any"],
  "intentsToGenerate": [
    {
      "goalBasket": "work|health|family|wealth|growth|life",
      "objective": "The single decision this card helps the user make",
      "whyNow": "Specific trigger grounded in the context brief",
      "expectedAction": "Concrete default action the card should suggest",
      "evidenceRefs": ["profile.goals", "incremental.personal"],
      "contextGaps": ["Optional intent-specific missing context"]
    }
  ]
}
\`\`\`
</output_format>

<example>
{
  "reasoning": "User's goal to improve fitness intersects with a fresh signal: their gym membership renews in 3 days. Calendar shows no workouts scheduled this week. This is a high-leverage moment to lock in a routine before the renewal decision.",
  "contextGaps": ["No data on user's current workout frequency or preferences"],
  "intentsToGenerate": [
    {
      "goalBasket": "health",
      "objective": "Decide whether to renew gym membership or switch to a home workout plan",
      "whyNow": "Gym membership auto-renews on April 12; user has 3 days to cancel or adjust",
      "expectedAction": "Review gym usage stats and decide: renew, downgrade, or cancel",
      "evidenceRefs": ["profile.goals", "personal.connections", "incremental.personal"],
      "contextGaps": ["Missing gym visit frequency data"]
    }
  ]
}
</example>`;
}
