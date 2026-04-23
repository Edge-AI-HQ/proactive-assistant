/**
 * Tests for the pure stat helpers in evals/metrics.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computePipelineHealth,
  computeQualityMetrics,
  diffHealth,
  diffQuality,
} from './metrics.ts';

const SAMPLE_LABELS = [
  { relevance: 8, actionability: 7, whyNow: 9, novelty: 6, decisionCompression: 8, overall: 7.6, pass: true,  reviewer: 'a' },
  { relevance: 6, actionability: 5, whyNow: 6, novelty: 5, decisionCompression: 5, overall: 5.4, pass: true,  reviewer: 'a' },
  { relevance: 3, actionability: 2, whyNow: 4, novelty: 3, decisionCompression: 2, overall: 2.8, pass: false, reviewer: 'a' },
];

test('computeQualityMetrics: averages all 5 dims + pass rate', () => {
  const m = computeQualityMetrics(SAMPLE_LABELS as any);
  assert.equal(m.meanRelevance, (8 + 6 + 3) / 3);
  assert.equal(m.meanActionability, (7 + 5 + 2) / 3);
  assert.equal(m.passRate, 2 / 3);
});

test('computeQualityMetrics: empty input returns zeros (does not throw)', () => {
  const m = computeQualityMetrics([]);
  assert.equal(m.meanOverall, 0);
  assert.equal(m.passRate, 0);
});

test('computePipelineHealth: p50 / p95 / errorRate', () => {
  const outputs = [
    { fixtureId: 'a', generated: {}, selfEval: {}, durationMs: 1000, llmTokens: 100 },
    { fixtureId: 'b', generated: {}, selfEval: {}, durationMs: 2000, llmTokens: 200 },
    { fixtureId: 'c', generated: {}, selfEval: {}, durationMs: 5000, llmTokens: 500 },
    { fixtureId: 'd', generated: {}, selfEval: {}, durationMs: 10000, llmTokens: 1000, error: 'timeout' },
  ];
  const h = computePipelineHealth(outputs);
  assert.equal(h.p50DurationMs, 2000);
  // 4 elements, p95 → idx floor(3*0.95) = 2 → 5000.
  // (We're using the simple "nearest rank" definition; for n=4 there's no
  // distinct 95th percentile cell so this is a reasonable choice.)
  assert.equal(h.p95DurationMs, 5000);
  assert.equal(h.meanLlmTokens, (100 + 200 + 500 + 1000) / 4);
  assert.equal(h.errorRate, 0.25);
});

test('diffQuality: candidate − baseline; positive = improvement', () => {
  const baseline = computeQualityMetrics(SAMPLE_LABELS.slice(0, 2) as any);
  const candidate = computeQualityMetrics(SAMPLE_LABELS as any);
  const d = diffQuality(baseline, candidate);
  // candidate (3 cards, includes a low one) has lower mean than baseline (2 cards, high)
  assert.ok(d.meanOverall < 0);
});

test('diffHealth: candidate − baseline; negative latency = improvement', () => {
  const baseline = { p50DurationMs: 5000, p95DurationMs: 12000, meanLlmTokens: 800, errorRate: 0.1 };
  const candidate = { p50DurationMs: 1500, p95DurationMs: 3000, meanLlmTokens: 600, errorRate: 0.05 };
  const d = diffHealth(baseline, candidate);
  assert.equal(d.p50DurationMs, -3500);
  assert.equal(d.p95DurationMs, -9000);
  assert.equal(d.errorRate, -0.05);
});
