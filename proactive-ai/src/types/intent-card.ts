/**
 * Core types for Intent Card generation pipeline.
 *
 * An Intent Card is the atomic unit of the Proactive AI system:
 * "AI's pre-processed next-best-action, ready for user approval."
 *
 * Design principles (from product definition):
 * - One card = one decision
 * - Must link to a Goal Basket
 * - Must explain "Why now"
 * - Must have a default action
 * - Must be skippable / snoozeable / revocable
 */

// ── Goal Baskets (6 life dimensions) ──

export type GoalBasket = 'work' | 'health' | 'family' | 'wealth' | 'growth' | 'life';

export const GOAL_BASKETS: readonly GoalBasket[] = [
  'work', 'health', 'family', 'wealth', 'growth', 'life',
] as const;

// ── Intent Card ──

export interface IntentCardAction {
  label: string;
  type: 'confirm' | 'modify' | 'snooze' | 'dismiss';
}

export interface IntentCard {
  id: string;
  goalBasket: GoalBasket;
  title: string;
  whyNow: string;
  summary: string;
  primaryAction: IntentCardAction;
  secondaryActions: IntentCardAction[];
  confidence: number;      // 0.0 – 1.0
  urgency: number;         // 0.0 – 1.0
  importance: number;      // 0.0 – 1.0
  sources: string[];       // data sources used
  agentChain: string[];    // which agents produced this
  createdAt: string;       // ISO 8601
}

// ── Pipeline types ──

export interface PlannerOutput {
  reasoning: string;
  intentsToGenerate: IntentPlan[];
}

export interface IntentPlan {
  goalBasket: GoalBasket;
  objective: string;
  dataSources: string[];   // which pin-cli commands to call
  whyNow: string;
  expectedAction: string;
}

export interface GeneratorOutput {
  cards: IntentCard[];
}

export interface EvaluationScore {
  cardId: string;
  overall: number;           // 0.0 – 10.0
  dimensions: {
    relevance: number;       // how relevant to user's goals
    actionability: number;   // how concrete the suggested action is
    whyNowClarity: number;   // how clear the timing rationale is
    novelty: number;         // not repeating known info
    decisionCompression: number; // how much thinking it saves the user
  };
  feedback: string;          // improvement suggestions for next iteration
  pass: boolean;             // meets quality threshold (>= 7.0)
}

export interface EvaluatorOutput {
  evaluations: EvaluationScore[];
  bestCards: IntentCard[];   // cards that passed quality threshold
  iterationFeedback: string; // overall feedback for next planner iteration
}

// ── Pipeline result (sent to frontend) ──

export interface PipelineIteration {
  iteration: number;
  plan: PlannerOutput;
  cards: IntentCard[];
  evaluation: EvaluatorOutput;
}

export interface PipelineResult {
  runId: string;
  iterations: PipelineIteration[];
  finalCards: IntentCard[];    // best cards across all iterations
  totalIterations: number;
}

// ── Server events (SSE) ──

export type ServerEvent =
  | { type: 'pipeline:start'; data: { maxIterations: number } }
  | { type: 'pipeline:iteration'; data: { iteration: number; phase: 'planning' | 'generating' | 'evaluating' } }
  | { type: 'pipeline:cards'; data: { iteration: number; cards: IntentCard[] } }
  | { type: 'pipeline:evaluation'; data: { iteration: number; evaluation: EvaluatorOutput } }
  | { type: 'pipeline:complete'; data: PipelineResult }
  | { type: 'pipeline:error'; data: { message: string } };
