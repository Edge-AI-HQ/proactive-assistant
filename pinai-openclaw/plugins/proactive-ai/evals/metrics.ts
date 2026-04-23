/**
 * Pure stat helpers — no DB / no LLM. Used by both runner/diff.ts and the
 * online dashboard. See evals/README.md.
 */
import type {
  CardLabels,
  PipelineHealthMetrics,
  QualityMetrics,
  ReplayCardOutput,
} from './types.js';

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx]!;
}

/**
 * Aggregate per-card labels into the 5 dimension means + pass rate.
 * Caller decides whether `labels` is the human golden set or the
 * agent's self-eval; the metric shape is the same.
 */
export function computeQualityMetrics(labels: CardLabels[]): QualityMetrics {
  return {
    meanRelevance: mean(labels.map((l) => l.relevance)),
    meanActionability: mean(labels.map((l) => l.actionability)),
    meanWhyNow: mean(labels.map((l) => l.whyNow)),
    meanNovelty: mean(labels.map((l) => l.novelty)),
    meanDecisionCompression: mean(labels.map((l) => l.decisionCompression)),
    meanOverall: mean(labels.map((l) => l.overall)),
    passRate: labels.length === 0 ? 0 : labels.filter((l) => l.pass).length / labels.length,
  };
}

export function computePipelineHealth(outputs: ReplayCardOutput[]): PipelineHealthMetrics {
  const durations = outputs.map((o) => o.durationMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const tokens = outputs.map((o) => o.llmTokens).filter((n) => Number.isFinite(n));
  const errors = outputs.filter((o) => !!o.error).length;
  return {
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    meanLlmTokens: mean(tokens),
    errorRate: outputs.length === 0 ? 0 : errors / outputs.length,
  };
}

export function diffQuality(
  baseline: QualityMetrics,
  candidate: QualityMetrics,
): QualityMetrics {
  return {
    meanRelevance: candidate.meanRelevance - baseline.meanRelevance,
    meanActionability: candidate.meanActionability - baseline.meanActionability,
    meanWhyNow: candidate.meanWhyNow - baseline.meanWhyNow,
    meanNovelty: candidate.meanNovelty - baseline.meanNovelty,
    meanDecisionCompression: candidate.meanDecisionCompression - baseline.meanDecisionCompression,
    meanOverall: candidate.meanOverall - baseline.meanOverall,
    passRate: candidate.passRate - baseline.passRate,
  };
}

export function diffHealth(
  baseline: PipelineHealthMetrics,
  candidate: PipelineHealthMetrics,
): PipelineHealthMetrics {
  return {
    p50DurationMs: candidate.p50DurationMs - baseline.p50DurationMs,
    p95DurationMs: candidate.p95DurationMs - baseline.p95DurationMs,
    meanLlmTokens: candidate.meanLlmTokens - baseline.meanLlmTokens,
    errorRate: candidate.errorRate - baseline.errorRate,
  };
}
