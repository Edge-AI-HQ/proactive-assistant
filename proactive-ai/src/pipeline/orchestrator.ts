/**
 * Pipeline Orchestrator — runs the Planner -> Generator -> Evaluator loop.
 *
 * This is the core engine of the Proactive AI system. It:
 * 1. Spawns a Planner agent to decide what cards to create
 * 2. Spawns a Generator agent to create the cards
 * 3. Spawns an Evaluator agent to score and filter cards
 * 4. Loops N times, feeding structured context from previous iteration
 * 5. Selects the best cards across all iterations
 *
 * Card selection strategy:
 *   - All cards across all iterations go into a candidate pool with their evaluation scores
 *   - Only cards that passed (overall >= 7.0) are eligible
 *   - Sorted by Evaluator's `overall` score (5-dimension average) — the authoritative quality signal
 *   - Diversity constraint: max 2 cards per goalBasket
 *   - Final output: top 5
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
import { DEFAULT_GENERATION_LANGUAGE, type SupportedGenerationLanguage } from '../types/generation-language.js';
import type {
  IntentCard,
  PlannerOutput,
  GeneratorOutput,
  EvaluatorOutput,
  EvaluationScore,
  PipelineIteration,
  PipelineResult,
  ServerEvent,
} from '../types/index.js';

export interface PipelineOptions {
  maxIterations: number;
  agentTimeoutMs: number;
  runId?: string;
  outputLanguage?: SupportedGenerationLanguage;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxIterations: 2,
  agentTimeoutMs: 300_000, // 5 minutes per agent
  outputLanguage: DEFAULT_GENERATION_LANGUAGE,
};

type EventSink = (event: ServerEvent) => void;

/** A card paired with its evaluation score, tracked across iterations */
interface ScoredCandidate {
  card: IntentCard;
  score: EvaluationScore;
  iteration: number;
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
  const iterations: PipelineIteration[] = [];
  const candidatePool: ScoredCandidate[] = [];
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
      recentFeedbackSummary,
      previousFeedback: prev?.feedback,
      previousPlan: prev ? JSON.stringify(prev.plan, null, 2) : undefined,
      previousCards: prev ? JSON.stringify(prev.cards, null, 2) : undefined,
      previousScores: prev ? JSON.stringify(prev.scores, null, 2) : undefined,
      outputLanguage,
    });

    const planText = await runAgent(api, `plan:${i}`, plannerPrompt, 'Generate an intent card plan based on the user\'s current context.', opts.agentTimeoutMs);
    const plan = parseAgentJsonOrThrow<PlannerOutput>(planText, `plan:${i}`);

    if (!plan.intentsToGenerate?.length) {
      api.logger.warn(`Planner iteration ${i} produced no intents, stopping`);
      break;
    }

    // ── Phase 2: Generator ──
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

    const cardsText = await runAgent(api, `generate:${i}`, generatorPrompt, 'Generate intent cards based on the plan.', opts.agentTimeoutMs);
    const generated = parseAgentJsonOrThrow<GeneratorOutput>(cardsText, `generate:${i}`);

    if (!generated.cards?.length) {
      api.logger.warn(`Generator iteration ${i} produced no cards, stopping`);
      break;
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
      for (const card of generated.cards) {
        candidatePool.push({
          card,
          score: syntheticScore(card.id),
          iteration: i,
        });
      }
    } else {
      emit({ type: 'pipeline:evaluation', data: { iteration: i, evaluation } });

      // Pair each card with its evaluation score and add to pool
      for (const card of generated.cards) {
        const score = evaluation.evaluations.find(e => e.cardId === card.id);
        if (score) {
          candidatePool.push({ card, score, iteration: i });
        }
      }

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

  const finalCards = selectBestCards(candidatePool);

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
 * Select the best cards from the candidate pool across all iterations.
 *
 * Strategy:
 * 1. Deduplicate: same-intent cards across iterations → keep highest score
 * 2. Filter: only cards that passed (overall >= 5.0)
 * 3. Sort: by Evaluator's `overall` score descending
 * 4. Diversify: max 3 cards per goalBasket
 * 5. Take top 10
 *
 * If no cards pass, fall back to the highest-scoring cards regardless of threshold.
 */
function selectBestCards(pool: ScoredCandidate[]): IntentCard[] {
  if (pool.length === 0) return [];

  // Step 1: Deduplicate — across iterations, same-intent cards get refined
  // but are conceptually the same. Keep the highest-scoring version.
  const deduped = deduplicateByIntent(pool);

  // Step 2+3: Sort by overall score
  const sorted = [...deduped].sort((a, b) => b.score.overall - a.score.overall);

  // Step 4: Try with pass threshold first
  let selected = pickWithDiversity(sorted.filter(c => c.score.pass && c.score.overall >= PASS_THRESHOLD));

  // Fallback: if nothing passed, take the best available
  if (selected.length === 0) {
    selected = pickWithDiversity(sorted);
  }

  return selected;
}

/**
 * Deduplicate cards that represent the same intent across iterations.
 *
 * Two cards are considered the same intent if they share the same goalBasket
 * AND have high title similarity (normalized Jaccard similarity >= 0.4).
 * Among duplicates, the one with the highest overall score wins.
 */
function deduplicateByIntent(pool: ScoredCandidate[]): ScoredCandidate[] {
  const kept: ScoredCandidate[] = [];

  for (const candidate of pool) {
    const existingIdx = kept.findIndex(
      k => k.card.goalBasket === candidate.card.goalBasket
        && titleSimilarity(k.card.title, candidate.card.title) >= 0.4,
    );

    if (existingIdx === -1) {
      // No similar card found — add as new
      kept.push(candidate);
    } else if (candidate.score.overall > kept[existingIdx]!.score.overall) {
      // Found similar card but this one scores higher — replace
      kept[existingIdx] = candidate;
    }
    // Otherwise: existing card scores higher, skip this one
  }

  return kept;
}

/** Jaccard similarity on lowercased word sets */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
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
