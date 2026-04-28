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
import { makeIntentKey } from '../shared/intent-key.js';

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

function collectCardText(card: Record<string, unknown>): string {
  const sources = Array.isArray(card.sources)
    ? card.sources.filter((item): item is string => typeof item === 'string')
    : [];
  return [
    card.title,
    card.whyNow,
    card.summary,
    ...sources,
  ]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
}

function isGenericHomeCalendarCard(card: Record<string, unknown>): boolean {
  const text = collectCardText(card);
  const lower = text.toLowerCase();
  const hasHome = /\bhome\b/i.test(text);
  const hasCalendarSource = /gcal|calendar|google calendar|日历/.test(lower);
  const looksLikePlaceholder = /placeholder|all-day|占位|全天|连续|远程办公|休假|jun-jul|6月|7月|42\s*days/.test(lower);
  return hasHome && hasCalendarSource && looksLikePlaceholder;
}

export async function runPipeline(
  api: OpenClawPluginApi,
  opts: PipelineOptions,
  onEvent?: EventSink,
): Promise<{
  runId: string;
  totalIterations: number;
  finalCards: Array<Record<string, unknown>>;
  scoreMap: Record<string, unknown>;
  signalDelta: { openBefore: number; openAfter: number; consumedByRun: number };
}> {
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
    // No --since: '14d' was a no-op (SQL string compare against ISO always
    // passes). Rely on --limit + recency ordering.
    recentGeneratedCardsSummary = await loadRecentGeneratedCardsSummary({ limit: 10 });
  } catch (err) {
    api.logger.warn(`Failed to load recent generated cards summary: ${err instanceof Error ? err.message : err}`);
  }
  try {
    learnedSkillsSection = await loadActiveSkillsSection();
  } catch (err) {
    api.logger.warn(`Failed to load learned skills section: ${err instanceof Error ? err.message : err}`);
  }

  emit({ type: 'pipeline:start', data: { maxIterations: opts.maxIterations } });

  // Observability: surface context-loading outcome and the size of the
  // incremental signal layer before the agent runs. Lets us judge whether
  // signals are actually being consumed run-over-run.
  let openSignalsBefore = 0;
  try {
    openSignalsBefore = await db.countPersonalSignals({ status: 'open' });
  } catch (err) {
    api.logger.warn(`Failed to count open personal_signals: ${err instanceof Error ? err.message : err}`);
  }
  emit({
    type: 'pipeline:context',
    data: {
      feedbackLoaded: feedbackSummary.length > 0,
      cardsHistoryLoaded: recentGeneratedCardsSummary.length > 0,
      skillsLoaded: learnedSkillsSection.length > 0,
      openSignalCount: openSignalsBefore,
    },
  });
  api.logger.info(
    `[pipeline:context] feedbackLoaded=${feedbackSummary.length > 0} cardsHistoryLoaded=${recentGeneratedCardsSummary.length > 0} skillsLoaded=${learnedSkillsSection.length > 0} openSignalCount=${openSignalsBefore}`,
  );

  const iterations: Array<{
    plan: Record<string, unknown>;
    cards: Array<Record<string, unknown>>;
    evaluation: Record<string, unknown> | null;
  }> = [];
  // Accumulate scored cards across all iterations. Previously this was
  // `lastScoredCards` and got overwritten each loop, which silently
  // discarded earlier iterations' output — multi-iteration runs would
  // throw away iter 1's cards entirely and use only the last iteration.
  // Now selectBestCards picks from the union of all iterations.
  const allScoredCards: ScoredCard[] = [];

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

    // Build scored cards and append to the run-wide pool (one entry per
    // generated card across all iterations).
    const iterationScored: ScoredCard[] = cards.map((card) => {
      const cardId = card['id'] as string;
      const evalScore = evaluations.find(e => e.cardId === cardId);
      return { card, score: { cardId, overall: evalScore?.overall ?? 7.0, pass: evalScore?.pass ?? true } };
    });
    allScoredCards.push(...iterationScored);

    // Observability: per-iteration summary so we can decide later whether
    // reasoning / iterationFeedback / rejected-card feedback is worth piping
    // back into the next iteration's prompt.
    const cardsById = new Map<string, Record<string, unknown>>(
      cards.map((card) => [String(card['id'] ?? ''), card]),
    );
    const rejectedCards = evaluations
      .filter((entry) => entry?.pass === false)
      .map((entry) => {
        const cardId = typeof entry.cardId === 'string' ? entry.cardId : '';
        const card = cardId ? cardsById.get(cardId) : undefined;
        return {
          cardId,
          title: typeof card?.['title'] === 'string' ? card['title'] : null,
          goalBasket: typeof card?.['goalBasket'] === 'string' ? card['goalBasket'] : null,
          overall: typeof entry.overall === 'number' ? entry.overall : null,
          feedback: typeof (entry as { feedback?: unknown }).feedback === 'string'
            ? (entry as { feedback?: string }).feedback ?? null
            : null,
        };
      });
    const passedCount = evaluations.filter((entry) => entry?.pass !== false).length;
    emit({
      type: 'pipeline:iteration-summary',
      data: {
        iteration: i,
        reasoning: output.reasoning ?? '',
        iterationFeedback: output.iterationFeedback ?? '',
        generatedCount: cards.length,
        passedCount,
        rejectedCount: rejectedCards.length,
        rejectedCards,
      },
    });
    const reasoningPreview = (output.reasoning ?? '').replace(/\s+/g, ' ').slice(0, 160);
    const iterationFeedbackPreview = (output.iterationFeedback ?? '').replace(/\s+/g, ' ').slice(0, 160);
    api.logger.info(
      `[pipeline:iteration-summary] iteration=${i} generated=${cards.length} passed=${passedCount} rejected=${rejectedCards.length} reasoning="${reasoningPreview}" iterationFeedback="${iterationFeedbackPreview}"`,
    );
    if (rejectedCards.length > 0) {
      for (const r of rejectedCards) {
        api.logger.info(
          `[pipeline:iteration-summary] rejected iteration=${i} cardId=${r.cardId} basket=${r.goalBasket ?? 'unknown'} overall=${r.overall ?? 'n/a'} title="${(r.title ?? '').slice(0, 80)}" feedback="${(r.feedback ?? '').slice(0, 160)}"`,
        );
      }
    }

    iterations.push({
      plan: { reasoning: output.reasoning ?? '' },
      cards,
      evaluation,
    });
  }

  const selectableCards = allScoredCards.filter((entry) => {
    const card = entry.card;
    if (!card || typeof card !== 'object') return true;
    return !isGenericHomeCalendarCard(card as Record<string, unknown>);
  });
  const suppressedCount = allScoredCards.length - selectableCards.length;
  if (suppressedCount > 0) {
    api.logger.info(`Suppressed ${suppressedCount} generic Home calendar card(s) from final selection`);
  }

  // Observability: tag each selectable card with its existing intent_thread
  // decision (suppress / hold / refine / advance) without affecting the
  // selection ranking. Lets us see how often candidates collide with prior
  // dismiss/hold threads before deciding on hard or soft de-dup.
  const threadMatchDetails: Array<{
    cardId: string;
    title: string | null;
    intentKey: string;
    score: number;
    threadDecision: db.ThreadDecision;
    latestCardOutcome: db.CardOutcome;
    hasAnyDismissedCard: boolean;
  }> = [];
  for (const entry of selectableCards) {
    const card = entry.card;
    const basket = typeof card['goalBasket'] === 'string' ? (card['goalBasket'] as string) : 'unknown';
    const title = typeof card['title'] === 'string' ? (card['title'] as string) : '';
    if (!title) continue;
    const intentKey = makeIntentKey(basket, title);
    let context: db.ThreadContext;
    try {
      context = await db.getThreadContext(intentKey);
    } catch (err) {
      api.logger.warn(`Failed to load thread context for ${intentKey}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (context.threadDecision === 'hold' && context.latestCardOutcome === 'none') {
      // 'hold' is the default for any intent_key without a real prior thread,
      // so emitting it for every brand-new card would be noise. Only surface
      // the match when the thread carries a real prior outcome or non-hold
      // decision (suppress / refine / advance).
      continue;
    }
    threadMatchDetails.push({
      cardId: typeof card['id'] === 'string' ? (card['id'] as string) : '',
      title,
      intentKey,
      score: entry.score.overall,
      threadDecision: context.threadDecision,
      latestCardOutcome: context.latestCardOutcome,
      hasAnyDismissedCard: context.hasAnyDismissedCard,
    });
  }
  if (threadMatchDetails.length > 0) {
    const suppressMatches = threadMatchDetails.filter((t) => t.threadDecision === 'suppress').length;
    const holdMatches = threadMatchDetails.filter((t) => t.threadDecision === 'hold').length;
    const refineMatches = threadMatchDetails.filter((t) => t.threadDecision === 'refine').length;
    const advanceMatches = threadMatchDetails.filter((t) => t.threadDecision === 'advance').length;
    emit({
      type: 'pipeline:thread-matches',
      data: {
        suppressMatches,
        holdMatches,
        refineMatches,
        advanceMatches,
        details: threadMatchDetails,
      },
    });
    api.logger.info(
      `[pipeline:thread-matches] suppress=${suppressMatches} hold=${holdMatches} refine=${refineMatches} advance=${advanceMatches}`,
    );
    for (const detail of threadMatchDetails) {
      api.logger.info(
        `[pipeline:thread-matches] cardId=${detail.cardId} decision=${detail.threadDecision} latestOutcome=${detail.latestCardOutcome} score=${detail.score} title="${(detail.title ?? '').slice(0, 80)}"`,
      );
    }
  }

  const finalCards = selectBestCards(selectableCards);

  // Build score map across ALL iterations (was previously only the last
  // iteration's evaluations, which paired with the lastScoredCards bug
  // erased earlier scores). Card ids are globally unique within a run
  // (`${runId}_i${i}_${j}`), so concatenating cannot produce key
  // collisions across iterations.
  const scoreMap: Record<string, unknown> = {};
  for (const iter of iterations) {
    const evals = (iter.evaluation as { evaluations?: Array<Record<string, unknown>> } | null | undefined)?.evaluations;
    if (!evals) continue;
    for (const score of evals) {
      if (typeof score['cardId'] === 'string') scoreMap[score['cardId'] as string] = score;
    }
  }

  // Save run + iterations artifact to DB / filesystem
  await db.savePipelineRun({
    runId, status: 'completed', totalIterations: iterations.length,
    finalCards, iterations: iterations.map((it, idx) => ({ iteration: idx + 1, ...it })),
  });
  const persistedRun = await db.getPipelineRun(runId);
  if (!persistedRun) {
    throw new Error(`Pipeline run ${runId} was not persisted`);
  }

  // Phase 1: also persist evaluations to indexable card_evaluations rows so
  // future evals harness can SQL-query scores per basket / dimension without
  // re-parsing the iterations JSON blob. See docs/plans/memory-architecture.mdx §三.
  let persistedEvaluations = 0;
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
      persistedEvaluations = evalRows.length;
    }
  } catch (err) {
    api.logger.warn(`Failed to persist card_evaluations: ${err instanceof Error ? err.message : err}`);
  }

  // Observability: re-count open signals after the run so we can see whether
  // the agent actually consumed anything via `pin signals consume`. Today
  // consumption depends entirely on LLM tool-calling; this delta tells us
  // when (or if) we need an orchestrator-level fallback.
  let openSignalsAfter = openSignalsBefore;
  try {
    openSignalsAfter = await db.countPersonalSignals({ status: 'open' });
  } catch (err) {
    api.logger.warn(`Failed to re-count open personal_signals: ${err instanceof Error ? err.message : err}`);
  }
  const signalDelta = {
    openBefore: openSignalsBefore,
    openAfter: openSignalsAfter,
    consumedByRun: Math.max(0, openSignalsBefore - openSignalsAfter),
  };
  api.logger.info(
    `[pipeline:signalDelta] runId=${runId} openBefore=${signalDelta.openBefore} openAfter=${signalDelta.openAfter} consumedByRun=${signalDelta.consumedByRun}`,
  );

  const result = { runId, totalIterations: iterations.length, finalCards, scoreMap, signalDelta };
  emit({
    type: 'pipeline:persisted',
    data: { runId, cards: finalCards.length, evaluations: persistedEvaluations },
  });
  emit({ type: 'pipeline:complete', data: result });
  return result;
}
