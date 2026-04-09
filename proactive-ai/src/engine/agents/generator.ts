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

  return `You are the **Generator Agent** in the Proactive AI intent card generation pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber}

**${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All user-visible text fields: title, whyNow, summary, primaryAction.label, secondaryActions[].label, feedback-facing strings, and sources",
  })}**

## Mission

Transform the Planner's intent plan into high-quality Intent Cards.
Use ONLY the provided evidence packs. Do not do open-ended discovery, do not search for extra tools, and do not invent claims beyond the evidence.

## The Plan

\`\`\`json
${plan}
\`\`\`

## Evidence Packs

\`\`\`json
${evidencePacks}
\`\`\`

## Generation Rules

1. **Evidence-bound** — every claim should map back to a provided fact or signal
2. **Decision compression** — save the user thinking time, don't dump raw evidence
3. **One card per intent** — do not merge or split intents
4. **Why now stays specific** — name the trigger in concrete terms
5. **No open-ended exploration** — if evidence is weak, acknowledge the limit in the summary instead of fetching more data

## Card Quality Checklist

- **Title**: clear action, specific, compact
- **Why Now**: one sentence, grounded in a concrete trigger
- **Summary**: 2-4 sentences, enough context to decide without extra research
- **Primary Action**: a clear confirm step
- **Secondary Actions**: modify + snooze + dismiss
- **Sources**: cite the evidence domains or fact groups actually used

${feedbackSection}
${deltaSection}
## Output Format

Output ONLY a JSON code block. No text outside the JSON.

\`\`\`json
{
  "cards": [
    {
      "id": "card_<iteration>_<index>",
      "goalBasket": "work|health|family|wealth|growth|life",
      "title": "Specific, actionable title",
      "whyNow": "One sentence with a concrete trigger",
      "summary": "2-4 sentences of compressed context grounded in the evidence pack",
      "primaryAction": { "label": "Concrete action", "type": "confirm" },
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

**Constraints:**
- Generate exactly one card per planned intent
- Card IDs must be unique: \`card_<iteration>_<1-based-index>\`
- All score values between 0.0 and 1.0
- createdAt must be ISO 8601-compatible
- If evidence is incomplete, stay honest rather than speculative`;
}
