/**
 * Pipeline orchestrator — Planner → Generator → Evaluator loop.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildPlannerPrompt } from '../agents/planner.js';
import { buildGeneratorPrompt } from '../agents/generator.js';
import { buildEvaluatorPrompt } from '../agents/evaluator.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from '../agents/generation-language.js';
import { runAgent, parseAgentJson, parseAgentJsonOrThrow } from './agent-runner.js';
import { selectBestCards, syntheticScore, type ScoredCard } from './card-selection.js';
import { loadRecentFeedbackSummary, formatRecentFeedbackSummary } from './feedback-summary.js';
import * as db from '../db.js';

export interface PipelineOptions {
  maxIterations: number;
  cardsPerIteration: number;
  agentTimeoutMs: number;
  outputLanguage?: SupportedGenerationLanguage;
}

interface PipelineIterResult {
  plan: Record<string, unknown>;
  cards: Array<Record<string, unknown>>;
  evaluation: Record<string, unknown> | null;
}

type EventSink = (event: { type: string; data: unknown }) => void;

export async function runPipeline(
  api: OpenClawPluginApi,
  opts: PipelineOptions,
  onEvent?: EventSink,
): Promise<{ runId: string; totalIterations: number; finalCards: Array<Record<string, unknown>>; scoreMap: Record<string, unknown> }> {
  const emit: EventSink = (event) => { try { onEvent?.(event); } catch { /* SSE write failure */ } };
  const currentDate = new Date().toISOString().slice(0, 10);
  const outputLanguage = opts.outputLanguage ?? DEFAULT_GENERATION_LANGUAGE;
  const runId = `run_manual_${Date.now().toString(36)}`;

  // Load feedback summary
  let feedbackSummary = '';
  try {
    feedbackSummary = formatRecentFeedbackSummary(await loadRecentFeedbackSummary());
  } catch (err) {
    api.logger.warn(`Failed to load feedback summary: ${err instanceof Error ? err.message : err}`);
  }

  emit({ type: 'pipeline:start', data: { maxIterations: opts.maxIterations } });

  const iterations: PipelineIterResult[] = [];
  let lastScoredCards: ScoredCard[] = [];
  let prev: { feedback: string; plan: string; cards: string; scores: string } | undefined;

  for (let i = 1; i <= opts.maxIterations; i++) {
    api.logger.info(`Pipeline iteration ${i}/${opts.maxIterations}`);

    // Phase 1: Planner
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'planning' } });
    const plannerPrompt = buildPlannerPrompt({
      currentDate, iterationNumber: i, cardsPerIteration: opts.cardsPerIteration,
      recentFeedbackSummary: feedbackSummary,
      previousFeedback: prev?.feedback, previousPlan: prev?.plan,
      previousCards: prev?.cards, previousScores: prev?.scores,
      outputLanguage,
    });
    const planText = await runAgent(api, `plan:${i}`, plannerPrompt, 'Gather the user\'s current context and generate an intent card plan.', opts.agentTimeoutMs);
    const plan = parseAgentJsonOrThrow<Record<string, unknown>>(planText, `plan:${i}`);
    if (!(plan['intentsToGenerate'] as unknown[])?.length) {
      api.logger.warn(`Planner iteration ${i} produced no intents, stopping`);
      break;
    }

    // Phase 2: Generator
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'generating' } });
    const generatorPrompt = buildGeneratorPrompt({
      currentDate, plan: JSON.stringify(plan, null, 2), iterationNumber: i,
      recentFeedbackSummary: feedbackSummary,
      previousFeedback: prev?.feedback, previousCards: prev?.cards, previousScores: prev?.scores,
      outputLanguage,
    });
    const cardsText = await runAgent(api, `generate:${i}`, generatorPrompt, 'Generate intent cards based on the plan and collected context.', opts.agentTimeoutMs);
    const generated = parseAgentJsonOrThrow<{ cards?: Array<Record<string, unknown>> }>(cardsText, `generate:${i}`);
    if (!generated.cards?.length) {
      api.logger.warn(`Generator iteration ${i} produced no cards, stopping`);
      break;
    }
    // Assign globally unique IDs
    for (let j = 0; j < generated.cards.length; j++) {
      generated.cards[j]!['id'] = `${runId}_i${i}_${j + 1}`;
    }
    emit({ type: 'pipeline:cards', data: { iteration: i, cards: generated.cards } });

    // Phase 3: Evaluator
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'evaluating' } });
    const evaluatorPrompt = buildEvaluatorPrompt({
      currentDate, plan: JSON.stringify(plan, null, 2), cards: JSON.stringify(generated, null, 2),
      iterationNumber: i, maxIterations: opts.maxIterations, outputLanguage,
    });
    const evalText = await runAgent(api, `evaluate:${i}`, evaluatorPrompt, 'Evaluate the generated intent cards for quality.', opts.agentTimeoutMs);
    const evaluation = parseAgentJson<{ evaluations?: Array<Record<string, unknown>>; iterationFeedback?: string }>(evalText);

    if (evaluation) emit({ type: 'pipeline:evaluation', data: { iteration: i, evaluation } });

    // Build scored cards
    const evalScores = (evaluation?.evaluations ?? []) as Array<{ cardId?: string; overall?: number; pass?: boolean }>;
    lastScoredCards = generated.cards.map((card) => {
      const cardId = card['id'] as string;
      const evalScore = evalScores.find(e => e.cardId === cardId);
      return { card, score: { cardId, overall: evalScore?.overall ?? 7.0, pass: evalScore?.pass ?? true } };
    });
    iterations.push({ plan, cards: generated.cards, evaluation });

    if (evaluation) {
      prev = {
        feedback: (evaluation['iterationFeedback'] as string) ?? '',
        plan: JSON.stringify(plan, null, 2),
        cards: JSON.stringify(generated.cards, null, 2),
        scores: JSON.stringify(evaluation['evaluations'] ?? [], null, 2),
      };
    }

    // Early stop if all scored >= 8.5
    const evals = (evaluation?.evaluations ?? []) as Array<{ overall?: number }>;
    if (evals.length > 0 && evals.every(e => (e.overall ?? 0) >= 8.5)) {
      api.logger.info(`All cards scored >= 8.5 at iteration ${i}, stopping early`);
      break;
    }
  }

  const finalCards = selectBestCards(lastScoredCards);

  // Build score map
  const scoreMap: Record<string, unknown> = {};
  const lastEval = iterations[iterations.length - 1]?.evaluation as { evaluations?: Array<Record<string, unknown>> } | undefined;
  if (lastEval?.evaluations) {
    for (const score of lastEval.evaluations) {
      if (typeof score['cardId'] === 'string') scoreMap[score['cardId'] as string] = score;
    }
  }

  // Save to DB
  await db.savePipelineRun({
    runId, status: 'completed', totalIterations: iterations.length,
    finalCards, iterations: iterations.map((it, idx) => ({ iteration: idx + 1, ...it })),
  });

  const result = { runId, totalIterations: iterations.length, finalCards, scoreMap };
  emit({ type: 'pipeline:complete', data: result });
  return result;
}
