/**
 * Core types for Intent Card generation pipeline.
 *
 * An Intent Card is the atomic unit of the Proactive AI system:
 * "AI's pre-processed next-best-action, ready for user approval."
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

export type PipelineIterationPhase = 'planning' | 'generating' | 'evaluating';
export type PipelineCompletionStatus = 'complete' | 'partial';
export type PipelineWarningFallback = 'previous_iteration' | 'synthetic_evaluation';

export interface PlannerOutput {
  reasoning?: string;
  collectedContext: Record<string, unknown>;  // raw data gathered by Planner via pin CLI
  intentsToGenerate: IntentPlan[];
}

export interface IntentPlan {
  goalBasket: GoalBasket;
  objective: string;
  whyNow: string;
  expectedAction: string;
  supportingData: string[];  // key data points from collectedContext backing this intent
}

export interface GeneratorOutput {
  cards: IntentCard[];
}

export interface EvaluationScore {
  cardId: string;
  overall: number;           // 0.0 – 10.0
  dimensions: {
    relevance: number;
    actionability: number;
    whyNowClarity: number;
    novelty: number;
    decisionCompression: number;
  };
  feedback: string;
  pass: boolean;
}

export interface EvaluatorOutput {
  evaluations: EvaluationScore[];
  bestCards: IntentCard[];
  iterationFeedback: string;
}

// ── Pipeline result ──

export interface PipelineIteration {
  iteration: number;
  plan: PlannerOutput;
  cards: IntentCard[];
  evaluation: EvaluatorOutput;
}

export interface PipelineWarning {
  iteration: number;
  phase: PipelineIterationPhase;
  fallback: PipelineWarningFallback;
  message: string;
}

export interface PipelineResult {
  runId: string;
  iterations: PipelineIteration[];
  finalCards: IntentCard[];
  totalIterations: number;
  completionStatus: PipelineCompletionStatus;
  warnings: PipelineWarning[];
}

// ── Server events (SSE) ──

export type ServerEvent =
  | { type: 'pipeline:start'; data: { maxIterations: number } }
  | { type: 'pipeline:iteration'; data: { iteration: number; phase: PipelineIterationPhase } }
  | { type: 'pipeline:cards'; data: { iteration: number; cards: IntentCard[] } }
  | { type: 'pipeline:evaluation'; data: { iteration: number; evaluation: EvaluatorOutput } }
  | { type: 'pipeline:complete'; data: PipelineResult }
  | { type: 'pipeline:error'; data: { message: string } };
