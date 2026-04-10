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

  return `You are an **Evaluator Worker** in the Proactive AI intent card generation pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber} of ${maxIterations}

**${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "All feedback text fields",
  })}**

## Mission

Evaluate exactly one card. Be strict and evidence-bound.
Do not re-select the final portfolio. Do not return the full card object.

## Planner Intent

\`\`\`json
${plan}
\`\`\`

## Card

\`\`\`json
${card}
\`\`\`

## Evidence Pack

\`\`\`json
${evidencePack}
\`\`\`

## Deterministic Validator Summary

\`\`\`json
${validatorSummary}
\`\`\`

## Output Format

Output ONLY a JSON code block.

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

**Constraints:**
- Evaluate only this card
- Be consistent with the validator summary
- Overall score must be the average of the 5 dimensions
- Use the evidence pack, not external exploration`;
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

  return `You are the **Feedback Synthesizer** in the Proactive AI intent card generation pipeline.
Today: ${currentDate} | Iteration: ${iterationNumber} of ${maxIterations}

**${buildOutputLanguageInstruction(outputLanguage, {
    fieldsDescription: "iterationFeedback",
  })}**

## Mission

Read the worker evaluations and validator output, then synthesize one concise iteration feedback string for the next round.
Do not return per-card scores and do not return full card objects.

## Worker Evaluations

\`\`\`json
${evaluations}
\`\`\`

## Validator Summary

\`\`\`json
${validatorSummary}
\`\`\`

## Output Format

Output ONLY a JSON code block.

\`\`\`json
{
  "iterationFeedback": "Explain what to preserve, what to tighten, and what to drop next round."
}
\`\`\`

**Constraints:**
- Focus on cross-card patterns, not line-by-line repetition
- ${isLastIteration ? "This is the final iteration, so keep feedback archival and brief." : "This feedback must be actionable for the next iteration."}`;
}
