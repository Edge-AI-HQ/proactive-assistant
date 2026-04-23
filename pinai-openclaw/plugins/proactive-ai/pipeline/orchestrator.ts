/**
 * Pipeline orchestrator — single unified generator agent.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildUnifiedGeneratorPrompt } from '../agents/unified-generator.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from '../agents/generation-language.js';
import { runAgent, parseAgentJsonOrThrow } from './agent-runner.js';
import { selectBestCards, type ScoredCard } from './card-selection.js';
import { loadRecentFeedbackSummary, formatRecentFeedbackSummary } from './feedback-summary.js';
import { loadRecentGeneratedCardsSummary } from './generated-cards-summary.js';
import { loadActiveSkillsSection } from '../conversation-crystallize/skill-injection.js';
import * as db from '../db.js';
import { extractCardEvaluationsForRun, type ScoredCardSource } from './extract-evaluations.js';

export interface PipelineOptions {
  maxIterations: number;
  cardsPerIteration: number;
  agentTimeoutMs: number;
  outputLanguage?: SupportedGenerationLanguage;
}

interface UnifiedGeneratorOutput {
  reasoning?: string;
  cards?: Array<Record<string, unknown>>;
  evaluations?: Array<Record<string, unknown>>;
  iterationFeedback?: string;
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

  // Load feedback and history summaries
  let feedbackSummary = '';
  let recentGeneratedCardsSummary = '';
  let learnedSkillsSection = '';
  try {
    feedbackSummary = formatRecentFeedbackSummary(await loadRecentFeedbackSummary());
  } catch (err) {
    api.logger.warn(`Failed to load feedback summary: ${err instanceof Error ? err.message : err}`);
  }
  try {
    recentGeneratedCardsSummary = await loadRecentGeneratedCardsSummary({ limit: 10, since: '14d' });
  } catch (err) {
    api.logger.warn(`Failed to load recent generated cards summary: ${err instanceof Error ? err.message : err}`);
  }
  try {
    learnedSkillsSection = await loadActiveSkillsSection();
  } catch (err) {
    api.logger.warn(`Failed to load learned skills section: ${err instanceof Error ? err.message : err}`);
  }

  emit({ type: 'pipeline:start', data: { maxIterations: opts.maxIterations } });

  const iterations: Array<{
    plan: Record<string, unknown>;
    cards: Array<Record<string, unknown>>;
    evaluation: Record<string, unknown> | null;
  }> = [];
  let lastScoredCards: ScoredCard[] = [];

  for (let i = 1; i <= opts.maxIterations; i++) {
    api.logger.info(`Pipeline iteration ${i}/${opts.maxIterations}`);
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'generating' } });

    // Build unified prompt
    const prompt = buildUnifiedGeneratorPrompt({
      currentDate,
      cardsToGenerate: opts.cardsPerIteration,
      recentFeedbackSummary: feedbackSummary,
      recentGeneratedCardsSummary,
      outputLanguage,
      learnedSkillsSection,
    });

    // Single agent call
    const agentText = await runAgent(
      api,
      `generate:${i}`,
      prompt,
      'Gather the user\'s current context, generate intent cards, and self-review them. Output the final JSON.',
      opts.agentTimeoutMs,
    );

    const output = parseAgentJsonOrThrow<UnifiedGeneratorOutput>(agentText, `generate:${i}`);

    // Extract cards
    const cards = output.cards ?? [];
    if (!cards.length) {
      api.logger.warn(`Generator iteration ${i} produced no cards, stopping`);
      break;
    }

    // Assign globally unique IDs
    for (let j = 0; j < cards.length; j++) {
      cards[j]!['id'] = `${runId}_i${i}_${j + 1}`;
    }
    emit({ type: 'pipeline:cards', data: { iteration: i, cards } });

    // Extract self-review evaluations
    const evaluations = (output.evaluations ?? []) as Array<{ cardId?: string; overall?: number; pass?: boolean }>;

    // Re-map evaluation cardIds to the newly assigned IDs (agent uses placeholder IDs)
    for (let j = 0; j < evaluations.length && j < cards.length; j++) {
      evaluations[j]!.cardId = cards[j]!['id'] as string;
    }

    const evaluation: Record<string, unknown> = {
      evaluations,
      iterationFeedback: output.iterationFeedback ?? '',
    };
    emit({ type: 'pipeline:evaluation', data: { iteration: i, evaluation } });

    // Build scored cards
    lastScoredCards = cards.map((card) => {
      const cardId = card['id'] as string;
      const evalScore = evaluations.find(e => e.cardId === cardId);
      return { card, score: { cardId, overall: evalScore?.overall ?? 7.0, pass: evalScore?.pass ?? true } };
    });

    iterations.push({
      plan: { reasoning: output.reasoning ?? '' },
      cards,
      evaluation,
    });
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

  // Save run + iterations artifact to DB / filesystem
  await db.savePipelineRun({
    runId, status: 'completed', totalIterations: iterations.length,
    finalCards, iterations: iterations.map((it, idx) => ({ iteration: idx + 1, ...it })),
  });

  // Phase 1: also persist evaluations to indexable card_evaluations rows so
  // future evals harness can SQL-query scores per basket / dimension without
  // re-parsing the iterations JSON blob. See docs/memory-architecture.md §三.
  try {
    const cardSources: ScoredCardSource[] = finalCards
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        id: typeof c['id'] === 'string' ? (c['id'] as string) : '',
        goalBasket: typeof c['goalBasket'] === 'string' ? (c['goalBasket'] as string) : null,
        intentKey: typeof c['intentKey'] === 'string' ? (c['intentKey'] as string) : null,
      }))
      .filter((c) => c.id.length > 0);
    const evalRows = extractCardEvaluationsForRun(runId, scoreMap, cardSources);
    if (evalRows.length > 0) {
      await db.saveCardEvaluations(evalRows);
    }
  } catch (err) {
    api.logger.warn(`Failed to persist card_evaluations: ${err instanceof Error ? err.message : err}`);
  }

  const result = { runId, totalIterations: iterations.length, finalCards, scoreMap };
  emit({ type: 'pipeline:complete', data: result });
  return result;
}
