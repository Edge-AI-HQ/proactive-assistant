import { buildOutputLanguageInstruction } from "./output-language.js";
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from "../generation-language.js";

export interface EvaluatorWorkerPromptParams {
  currentDate: string;
  iterationNumber: number;
  maxIterations: number;
  plan: string;
  card: string;
  evidencePack: string;
  validatorSummary: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export interface FeedbackSynthPromptParams {
  currentDate: string;
  iterationNumber: number;
  maxIterations: number;
  evaluations: string;
  validatorSummary: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export function buildEvaluatorWorkerPrompt(params: EvaluatorWorkerPromptParams): string {
  const {
    currentDate,
    iterationNumber,
    maxIterations,
    plan,
    card,
    evidencePack,
    validatorSummary,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;

  return `You are an Evaluator Worker in a Proactive AI pipeline. You score one intent card at a time.
Today: ${currentDate} | Iteration: ${iterationNumber} of ${maxIterations}

<language_requirement>
${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All feedback text fields",
  })}
</language_requirement>

<planner_intent>
${plan}
</planner_intent>

<card>
${card}
</card>

<evidence_pack>
${evidencePack}
</evidence_pack>

<validator_summary>
${validatorSummary}
</validator_summary>

<instructions>
Score this single card on 5 dimensions (0.0–10.0 each). The overall score is the average of the 5 dimensions.

Scoring dimensions:
- relevance: Does this card address something the user actually cares about, based on their goals and context?
- actionability: Can the user act on this card immediately, or does it require more research/context?
- whyNowClarity: Is the time-sensitive trigger concrete and verifiable, or vague/manufactured?
- novelty: Does this card surface something the user wouldn't have thought of on their own?
- decisionCompression: Does the card save thinking time by synthesizing evidence into a clear recommendation?

A card passes if overall >= 6.0.

Be consistent with the validator summary above — it contains deterministic checks you should not contradict. Write feedback as specific improvement suggestions the Generator can act on in the next iteration.
</instructions>

<output_format>
Respond with ONLY a JSON code block:

\`\`\`json
{
  "overall": 7.8,
  "dimensions": {
    "relevance": 8.0,
    "actionability": 7.5,
    "whyNowClarity": 8.0,
    "novelty": 7.5,
    "decisionCompression": 8.0
  },
  "feedback": "Specific improvement suggestions for this card",
  "pass": true
}
\`\`\`
</output_format>`;
}

export function buildFeedbackSynthPrompt(params: FeedbackSynthPromptParams): string {
  const {
    currentDate,
    iterationNumber,
    maxIterations,
    evaluations,
    validatorSummary,
    outputLanguage = DEFAULT_GENERATION_LANGUAGE,
  } = params;
  const isLastIteration = iterationNumber >= maxIterations;

  return `You are the Feedback Synthesizer in a Proactive AI pipeline. You distill evaluator scores into one actionable feedback string for the next iteration.
Today: ${currentDate} | Iteration: ${iterationNumber} of ${maxIterations}

<language_requirement>
${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "iterationFeedback",
  })}
</language_requirement>

<worker_evaluations>
${evaluations}
</worker_evaluations>

<validator_summary>
${validatorSummary}
</validator_summary>

<instructions>
Synthesize one concise feedback string covering: what to preserve, what to tighten, and what to drop.

Focus on cross-card patterns (e.g., "all cards had vague whyNow triggers") rather than repeating per-card feedback. ${isLastIteration ? "This is the final iteration — keep feedback archival and brief." : "This feedback feeds directly into the next Planner iteration, so make it actionable and specific."}
</instructions>

<output_format>
Respond with ONLY a JSON code block:

\`\`\`json
{
  "iterationFeedback": "What to preserve, what to tighten, and what to drop."
}
\`\`\`
</output_format>`;
}
