/**
 * Pipeline Orchestrator — runs the Planner -> Generator -> Evaluator loop.
 *
 * This is the core engine of the Proactive AI system. It:
 * 1. Spawns a Planner agent to gather context and decide what cards to create
 * 2. Spawns a Generator agent to create the cards (using Planner's collected data)
 * 3. Spawns an Evaluator agent to score and filter cards
 * 4. Loops N times, feeding structured feedback from previous iteration
 * 5. Selects the best cards from the latest iteration
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildPlannerPrompt } from '../agents/planner.js';
import { buildGeneratorPrompt } from '../agents/generator.js';
import { buildEvaluatorPrompt } from '../agents/evaluator.js';
import {
  formatRecentFeedbackSummary,
  loadRecentFeedbackSummary,
} from './feedback-summary.js';
import {
  detectAgentErrorInMessages,
  parseAgentJson,
  parseAgentJsonOrThrow,
} from './agent-output.js';
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from '../generation-language.js';
import type {
  IntentCard,
  PlannerOutput,
  GeneratorOutput,
  EvaluatorOutput,
  EvaluationScore,
  PipelineIteration,
  PipelineResult,
  ServerEvent,
} from '../../core/index.js';

export interface PipelineOptions {
  maxIterations: number;
  agentTimeoutMs: number;
  cardsPerIteration?: number;
  runId?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxIterations: 2,
  agentTimeoutMs: 300_000, // 5 minutes per agent
  cardsPerIteration: 8,
  outputLanguage: DEFAULT_GENERATION_LANGUAGE,
};

type EventSink = (event: ServerEvent) => void;

/** A card paired with its evaluation score. */
interface ScoredCandidate {
  card: IntentCard;
  score: EvaluationScore;
}

/** Structured context carried from iteration N to iteration N+1 */
interface IterationContext {
  feedback: string;
  plan: PlannerOutput;
  cards: IntentCard[];
  scores: EvaluationScore[];
}

/**
 * Run the full intent card generation pipeline.
 */
export async function runPipeline(
  api: OpenClawPluginApi,
  opts: PipelineOptions = DEFAULT_PIPELINE_OPTIONS,
  onEvent?: EventSink,
): Promise<PipelineResult> {
  const emit = onEvent ?? (() => {});
  const currentDate = new Date().toISOString().slice(0, 10);
  const outputLanguage = opts.outputLanguage ?? DEFAULT_GENERATION_LANGUAGE;
  const cardsPerIteration = opts.cardsPerIteration ?? 8;
  const iterations: PipelineIteration[] = [];
  let lastIterationCards: ScoredCandidate[] = [];
  const runId = opts.runId ?? `run_${Date.now().toString(36)}`;
  let recentFeedbackSummary = '';
  let prev: IterationContext | undefined;

  try {
    recentFeedbackSummary = formatRecentFeedbackSummary(
      await loadRecentFeedbackSummary({ since: '14d' }),
    );
  } catch (error) {
    api.logger.warn(
      `Failed to load recent feedback summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  emit({ type: 'pipeline:start', data: { maxIterations: opts.maxIterations } });

  for (let i = 1; i <= opts.maxIterations; i++) {
    api.logger.info(`Pipeline iteration ${i}/${opts.maxIterations}`);

    // ── Phase 1: Planner ──
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'planning' } });

    const plannerPrompt = buildPlannerPrompt({
      currentDate,
      iterationNumber: i,
      cardsPerIteration,
      recentFeedbackSummary,
      previousFeedback: prev?.feedback,
      previousPlan: prev ? JSON.stringify(prev.plan, null, 2) : undefined,
      previousCards: prev ? JSON.stringify(prev.cards, null, 2) : undefined,
      previousScores: prev ? JSON.stringify(prev.scores, null, 2) : undefined,
      outputLanguage,
    });

    const planText = await runAgent(api, `plan:${i}`, plannerPrompt, 'Gather the user\'s current context and generate an intent card plan.', opts.agentTimeoutMs);
    const plan = parseAgentJsonOrThrow<PlannerOutput>(planText, `plan:${i}`);

    if (!plan.intentsToGenerate?.length) {
      api.logger.warn(`Planner iteration ${i} produced no intents, stopping`);
      break;
    }

    // ── Phase 2: Generator ──
    // Pass the FULL plan (including collectedContext) so Generator doesn't re-fetch data
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'generating' } });

    const generatorPrompt = buildGeneratorPrompt({
      currentDate,
      plan: JSON.stringify(plan, null, 2),
      iterationNumber: i,
      recentFeedbackSummary,
      previousFeedback: prev?.feedback,
      previousCards: prev ? JSON.stringify(prev.cards, null, 2) : undefined,
      previousScores: prev ? JSON.stringify(prev.scores, null, 2) : undefined,
      outputLanguage,
    });

    const cardsText = await runAgent(api, `generate:${i}`, generatorPrompt, 'Generate intent cards based on the plan and collected context.', opts.agentTimeoutMs);
    const generated = parseAgentJsonOrThrow<GeneratorOutput>(cardsText, `generate:${i}`);

    if (!generated.cards?.length) {
      api.logger.warn(`Generator iteration ${i} produced no cards, stopping`);
      break;
    }

    // Assign globally unique IDs: runId + iteration + index
    for (let j = 0; j < generated.cards.length; j++) {
      generated.cards[j]!.id = `${runId}_i${i}_${j + 1}`;
    }

    emit({ type: 'pipeline:cards', data: { iteration: i, cards: generated.cards } });

    // ── Phase 3: Evaluator ──
    emit({ type: 'pipeline:iteration', data: { iteration: i, phase: 'evaluating' } });

    const evaluatorPrompt = buildEvaluatorPrompt({
      currentDate,
      plan: JSON.stringify(plan, null, 2),
      cards: JSON.stringify(generated, null, 2),
      iterationNumber: i,
      maxIterations: opts.maxIterations,
      outputLanguage,
    });

    const evalText = await runAgent(api, `evaluate:${i}`, evaluatorPrompt, 'Evaluate the generated intent cards for quality.', opts.agentTimeoutMs);
    const evaluation = parseAgentJson<EvaluatorOutput>(evalText);

    if (!evaluation) {
      api.logger.warn(`Evaluator iteration ${i} produced no output, using cards as-is`);
      // No scores — add cards with synthetic passing scores so they're still candidates
      lastIterationCards = generated.cards.map((card) => ({
        card,
        score: syntheticScore(card.id),
      }));
    } else {
      emit({ type: 'pipeline:evaluation', data: { iteration: i, evaluation } });

      // Pair each card with its evaluation score and add to pool
      lastIterationCards = generated.cards.map((card) => ({
        card,
        score: evaluation.evaluations.find((entry) => entry.cardId === card.id) ?? syntheticScore(card.id),
      }));

      // Build structured context for next iteration
      prev = {
        feedback: evaluation.iterationFeedback,
        plan,
        cards: generated.cards,
        scores: evaluation.evaluations,
      };
    }

    iterations.push({
      iteration: i,
      plan,
      cards: generated.cards,
      evaluation: evaluation ?? {
        evaluations: [],
        bestCards: generated.cards,
        iterationFeedback: 'No evaluation produced',
      },
    });

    // If all cards passed with high scores, no need to iterate more
    if (evaluation?.evaluations?.every(e => e.overall >= 8.5)) {
      api.logger.info(`All cards scored >= 8.5 at iteration ${i}, stopping early`);
      break;
    }
  }

  const finalCards = selectBestCards(lastIterationCards);

  const result: PipelineResult = {
    runId,
    iterations,
    finalCards,
    totalIterations: iterations.length,
  };

  emit({ type: 'pipeline:complete', data: result });
  return result;
}

// ── Card selection ──

const MAX_FINAL_CARDS = 10;
const MAX_PER_BASKET = 3;
const PASS_THRESHOLD = 5.0;

/**
 * Select the best cards from the latest iteration.
 *
 * Strategy:
 * 1. Filter: only cards that passed (overall >= 5.0)
 * 2. Sort: by Evaluator's `overall` score descending
 * 3. Diversify: max 3 cards per goalBasket
 * 4. Take top 10
 *
 * If no cards pass, fall back to the highest-scoring cards regardless of threshold.
 */
function selectBestCards(pool: ScoredCandidate[]): IntentCard[] {
  if (pool.length === 0) return [];

  const sorted = [...pool].sort((a, b) => b.score.overall - a.score.overall);

  let selected = pickWithDiversity(sorted.filter((candidate) => candidate.score.pass && candidate.score.overall >= PASS_THRESHOLD));
  if (selected.length === 0) {
    selected = pickWithDiversity(sorted);
  }

  return selected;
}

/** Pick top cards with basket diversity constraint */
function pickWithDiversity(candidates: ScoredCandidate[]): IntentCard[] {
  const result: IntentCard[] = [];
  const basketCount = new Map<string, number>();

  for (const { card } of candidates) {
    if (result.length >= MAX_FINAL_CARDS) break;

    const count = basketCount.get(card.goalBasket) ?? 0;
    if (count >= MAX_PER_BASKET) continue;

    result.push(card);
    basketCount.set(card.goalBasket, count + 1);
  }

  return result;
}

/** Create a synthetic passing score when Evaluator produces no output */
function syntheticScore(cardId: string): EvaluationScore {
  return {
    cardId,
    overall: 7.0,
    dimensions: { relevance: 7, actionability: 7, whyNowClarity: 7, novelty: 7, decisionCompression: 7 },
    feedback: 'No evaluation available — using default score',
    pass: true,
  };
}

// ── Agent runner ──

async function runAgent(
  api: OpenClawPluginApi,
  tag: string,
  systemPrompt: string,
  userMessage: string,
  timeoutMs: number,
): Promise<string> {
  const sessionKey = `agent:main:proactive-ai:${tag}:${Date.now().toString(36)}`;

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: systemPrompt,
    idempotencyKey: `proactive-ai:${tag}:${Date.now().toString(36)}`,
    message: userMessage,
    deliver: false,
  });

  const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs });

  // 'ok' = success. Anything else (error/timeout/failed) is a failure.
  // Check for 'ok' to stay forward-compatible with future status values.
  if (result.status !== 'ok') {
    throw new Error(`Agent ${tag} failed with status: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
  }

  // Extract the agent's final text output
  const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
  const messageError = detectAgentErrorInMessages(messages.messages);
  if (messageError) {
    throw new Error(`Agent ${tag} failed: ${messageError}`);
  }
  return extractAgentText(messages);
}

// ── Helpers ──

function extractAgentText(messages: { messages: unknown[] }): string {
  const assistantMsgs = (messages.messages as Array<{ role?: string; content?: unknown }>)
    .filter(m => m.role === 'assistant');
  const last = assistantMsgs[assistantMsgs.length - 1];

  if (!last?.content) return '';
  if (typeof last.content === 'string') return last.content.trim();
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
      .trim();
  }
  return '';
}
