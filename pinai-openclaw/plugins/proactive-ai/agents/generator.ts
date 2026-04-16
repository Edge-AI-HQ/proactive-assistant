/**
 * Generator Agent prompt builder — synced from standalone proactive-ai.
 */
import { buildOutputLanguageInstruction } from './output-language.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from './generation-language.js';
import { PIN_CLI_COMMAND_GUIDE } from './pin-cli-command-guide.js';

export interface GeneratorPromptParams {
  currentDate: string;
  plan: string;
  iterationNumber: number;
  recentFeedbackSummary?: string;
  recentGeneratedCardsSummary?: string;
  previousFeedback?: string;
  previousCards?: string;
  previousScores?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildGeneratorPrompt(params: GeneratorPromptParams): string {
  const {
    currentDate, plan, iterationNumber,
    recentFeedbackSummary, recentGeneratedCardsSummary, previousFeedback, previousCards, previousScores,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;

  const prevSection = previousFeedback ? `
<previous_iteration>
Iteration #${iterationNumber}. Improve on these — do not repeat the same cards.

<evaluator_feedback>
${previousFeedback}
</evaluator_feedback>

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

  return `You are the **Generator** in the Proactive AI intent card pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber}

${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All user-visible text fields: title, whyNow, summary, primaryAction.label, secondaryActions[].label, and sources",
  })}

<goal>
Transform the Planner's intent plan into polished, ready-to-approve Intent Cards. Each card will be shown directly to the user as a next-best-action recommendation.

The Planner has already gathered user context data — it is included in the plan below under \`collectedContext\`. Use this data to craft specific, evidence-backed cards. If you need additional details beyond what the Planner collected, you have access to the \`pin\` CLI (command reference in loaded skill documents).
</goal>

${PIN_CLI_COMMAND_GUIDE}

<plan>
${plan}
</plan>

<process>
Before generating cards, inspect recent generated history with \`pin cards recent --limit 10 --json\`. Use that result together with recent pushes and feedback to avoid producing near-duplicate card themes.

Treat sustained card-chat engagement as a strong signal for adjacent follow-up cards, but do not simply restate the same card. Turn that signal into the next upgraded, more actionable step around the same thread.

When recent generated-card history includes thread decisions:
- \`advance\`: generate the next-stage card for the same thread, not a restatement
- \`refine\`: keep the thread but change the action design, angle, or why-now trigger
- \`hold\`: deprioritize that thread unless fresh evidence makes it timely
- \`suppress\`: avoid near-duplicate cards for that thread unless a concrete new trigger overrides the prior negative signal
</process>

<card_quality_standards>
Each card must meet ALL of these:

- **Title**: One sentence, action-led, max 80 chars. Specific — "Book Dr. Wang Tue 10am" not "Consider scheduling a checkup"
- **Why Now**: One sentence with a concrete trigger — dates, numbers, events. Not vague.
- **Summary**: 2–4 sentences of compressed context. Everything the user needs to decide. Not a restatement of the title.
- **Primary Action**: Concrete, executable step. A button label with a verb + object. Never advisory ("consider", "look into").
- **Evidence-backed**: Every claim traces to real data from the Planner's collectedContext or your own pin CLI queries.
- **Decision compression**: The card saves the user thinking time. Present the distilled decision, not raw data.
- **Respectful tone**: Information over instruction. "Your sleep declined 15% this week" not "You should sleep more".
</card_quality_standards>
${feedbackSection}${recentGeneratedCardsSection}${prevSection}
<output_format>
Output ONLY a JSON code block:

\`\`\`json
{
  "cards": [
    {
      "id": "auto-assigned",
      "goalBasket": "work|health|family|wealth|growth|life",
      "title": "Specific, actionable title",
      "whyNow": "One sentence with specific trigger",
      "summary": "2–4 sentences of compressed context",
      "primaryAction": { "label": "Concrete action", "type": "confirm" },
      "secondaryActions": [
        { "label": "Modify", "type": "modify" },
        { "label": "Remind me later", "type": "snooze" },
        { "label": "Not relevant", "type": "dismiss" }
      ],
      "confidence": 0.85,
      "urgency": 0.7,
      "importance": 0.8,
      "sources": ["profile", "gmail via personal exec", "world headlines"],
      "agentChain": ["planner", "generator"],
      "createdAt": "${currentDate}"
    }
  ]
}
\`\`\`

- One card per planned intent. Do not skip any, do not add extras.
- Card IDs will be auto-assigned by the system — use any placeholder.
- All score values between 0.0 and 1.0.
</output_format>`;
}
