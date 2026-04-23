/**
 * Shared types for the eval harness. See evals/README.md.
 */

export interface CardLabels {
  relevance: number;
  actionability: number;
  whyNow: number;
  novelty: number;
  decisionCompression: number;
  overall: number;
  pass: boolean;
  reviewer: string;
  notes?: string;
}

export interface ContextPack {
  /** Long-term picture */
  profile: Record<string, unknown> | null;
  memories: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
  interests: Array<Record<string, unknown>>;
  /** Right-now context */
  signals: Array<Record<string, unknown>>;
  recentEmails: Array<Record<string, unknown>>;
  todayCalendar: Array<Record<string, unknown>>;
  installedApps: Array<Record<string, unknown>>;
  worldShortlist: Array<Record<string, unknown>>;
  /** Behaviour history */
  recentFeedback: string;
  recentCards: Array<Record<string, unknown>>;
  recentEvolutionRuns: Array<Record<string, unknown>>;
}

export interface GoldenFixture {
  id: string;
  contextPack: ContextPack;
  card: Record<string, unknown>;
  labels: CardLabels;
  capturedAt: string;
}

export interface ReplayCardOutput {
  fixtureId: string;
  /** card emitted by the candidate prompt for this fixture */
  generated: Record<string, unknown>;
  /** the agent's own self-eval scores */
  selfEval: Partial<CardLabels>;
  /** wallclock + tokens for this single replay */
  durationMs: number;
  llmTokens: number;
  error?: string;
}

export interface ReplayRun {
  id: string;
  startedAt: string;
  completedAt: string;
  promptHash: string;
  fixtureCount: number;
  outputs: ReplayCardOutput[];
}

export interface QualityMetrics {
  meanRelevance: number;
  meanActionability: number;
  meanWhyNow: number;
  meanNovelty: number;
  meanDecisionCompression: number;
  meanOverall: number;
  passRate: number;
}

export interface PipelineHealthMetrics {
  p50DurationMs: number;
  p95DurationMs: number;
  meanLlmTokens: number;
  errorRate: number;
}

export interface DiffReport {
  baselineRunId: string;
  candidateRunId: string;
  baseline: { quality: QualityMetrics; health: PipelineHealthMetrics };
  candidate: { quality: QualityMetrics; health: PipelineHealthMetrics };
  /** quality.candidate − quality.baseline (positive = improvement) */
  qualityDelta: QualityMetrics;
  /** health.candidate − health.baseline (NEGATIVE p50/p95 = improvement) */
  healthDelta: PipelineHealthMetrics;
}
