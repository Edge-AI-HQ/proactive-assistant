import { buildOutputLanguageInstruction } from "./output-language.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from "../generation-language.js";

export interface GeneratorPromptParams {
  currentDate: string;
  plan: string;
  evidencePacks: string;
  iterationNumber: number;
  previousIterationDelta?: string;
  recentFeedbackSummary?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildGeneratorPrompt(params: GeneratorPromptParams): string {
  const {
    currentDate,
    plan,
    evidencePacks,
    iterationNumber,
    previousIterationDelta,
    recentFeedbackSummary,
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

  return `You are the Generator Agent in a Proactive AI pipeline. You transform intent plans into user-facing intent cards — pre-processed next-best-actions the user can approve with one tap.
Today: ${currentDate} | Iteration: ${iterationNumber}

<language_requirement>
${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All user-visible text fields: title, whyNow, summary, primaryAction.label, secondaryActions[].label, feedback-facing strings, and sources",
  })}
</language_requirement>

<plan>
${plan}
</plan>

<evidence_packs>
${evidencePacks}
</evidence_packs>
${feedbackSection ? `\n<recent_feedback>\n${recentFeedbackSummary}\n</recent_feedback>` : ""}
${deltaSection ? `\n<previous_iteration_delta>\n${previousIterationDelta}\n</previous_iteration_delta>` : ""}
<instructions>
Generate exactly one card per planned intent using only the evidence above.

Writing principles:
1. Decision compression — the card should save the user thinking time. Synthesize evidence into a clear recommendation, don't dump raw facts. Users glance at cards in seconds; every word must earn its place.
2. Evidence-bound — every claim maps back to a provided fact or signal. If evidence is thin, say so honestly in the summary rather than speculating, because speculative cards destroy user trust.
3. Why-now stays concrete — name the specific trigger (a date, a change, a window closing). Vague urgency ("you should consider...") gets dismissed.
4. One card = one decision — don't merge or split intents, so the user has a clean yes/no/later choice.

Card field guidance:
- title: Clear action verb + specific subject, compact (under 60 chars)
- whyNow: One sentence. Name the trigger.
- summary: 2-4 sentences. Enough context to decide without opening another app.
- primaryAction.label: What happens when they tap "confirm" — be specific ("Book the 3pm slot", not "Take action")
- sources: Which evidence domains you actually used
</instructions>

<output_format>
Respond with ONLY a JSON code block:

\`\`\`json
{
  "cards": [
    {
      "id": "card_${iterationNumber}_1",
      "goalBasket": "work|health|family|wealth|growth|life",
      "title": "Specific, actionable title",
      "whyNow": "One sentence with a concrete trigger",
      "summary": "2-4 sentences of compressed context grounded in the evidence pack",
      "primaryAction": { "label": "Concrete confirm action", "type": "confirm" },
      "secondaryActions": [
        { "label": "Modify", "type": "modify" },
        { "label": "Remind me later", "type": "snooze" },
        { "label": "Not relevant", "type": "dismiss" }
      ],
      "confidence": 0.85,
      "urgency": 0.7,
      "importance": 0.8,
      "sources": ["profile.goals", "incremental.personal"],
      "agentChain": ["planner", "generator"],
      "createdAt": "${currentDate}"
    }
  ]
}
\`\`\`

Card IDs: \`card_<iteration>_<1-based-index>\`. Scores: 0.0–1.0. createdAt: ISO 8601.
</output_format>

<examples>
<example type="good">
{
  "id": "card_1_1",
  "goalBasket": "work",
  "title": "Reply to Sarah's partnership proposal before Friday deadline",
  "whyNow": "Sarah's email from Monday asks for a response by April 11; no reply sent yet.",
  "summary": "Sarah Chen proposed a joint webinar series targeting your shared audience (devtools engineers). The proposal includes 3 sessions over Q2 with shared promotion costs. Your calendar has open Thursday slots that fit her suggested times. Partnering aligns with your Q2 growth goal of expanding developer reach.",
  "primaryAction": { "label": "Draft a 'yes' reply to Sarah", "type": "confirm" },
  "secondaryActions": [
    { "label": "Modify reply", "type": "modify" },
    { "label": "Remind me Thursday morning", "type": "snooze" },
    { "label": "Not relevant", "type": "dismiss" }
  ],
  "confidence": 0.9,
  "urgency": 0.85,
  "importance": 0.75,
  "sources": ["personal.connections", "profile.goals", "incremental.personal"],
  "agentChain": ["planner", "generator"],
  "createdAt": "${currentDate}"
}
</example>
<example type="bad" reason="Vague title, no concrete trigger, speculative summary">
{
  "title": "Consider improving your work productivity",
  "whyNow": "It's always a good time to be more productive",
  "summary": "You might want to think about ways to improve your workflow. There are many tools and techniques available.",
  "primaryAction": { "label": "Take action", "type": "confirm" }
}
</example>
</examples>`;
}
