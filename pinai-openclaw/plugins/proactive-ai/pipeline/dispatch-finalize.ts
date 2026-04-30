/**
 * Durable pipeline run lifecycle: dispatch → (later) finalize.
 *
 * Splits the lifecycle into two halves so the in-flight subagent survives
 * HTTP timeouts, client disconnects, and process restarts:
 *
 *   1. dispatchPipelineAgent() — load context, build prompt, kick off the
 *      subagent, INSERT pipeline_runs(status='running') with subagent metadata.
 *      Returns immediately with the run id; the subagent is still working.
 *
 *   2. finalizePipelineRun() — once the agent's text is in hand (from the
 *      primary wait OR the reconciler), parse the JSON, score the cards,
 *      persist them, UPDATE pipeline_runs to 'completed'. Idempotent: a
 *      duplicate call is a no-op because the UPDATE filters on the in-flight
 *      statuses.
 *
 * The reconciler (tasks/handlers/pipeline-reconcile.ts) calls finalize when
 * the primary wait times out. The startup recovery hook calls finalize too,
 * after best-effort reading session messages without a fresh waitForRun.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildUnifiedGeneratorPrompt } from '../agents/unified-generator.js';
import {
  DEFAULT_GENERATION_LANGUAGE,
  type SupportedGenerationLanguage,
} from '../agents/generation-language.js';
import { dispatchAgent, parseAgentJsonOrThrow } from './agent-runner.js';
import { selectBestCards, type ScoredCard } from './card-selection.js';
import {
  loadRecentFeedbackSummary,
  formatRecentFeedbackSummary,
} from './feedback-summary.js';
import { loadRecentGeneratedCardsSummary } from './generated-cards-summary.js';
import { loadActiveSkillsSection } from '../conversation-crystallize/skill-injection.js';
import * as db from '../db.js';
import { extractCardEvaluationsForRun, type ScoredCardSource } from './extract-evaluations.js';
import { makeIntentKey } from '../shared/intent-key.js';

/** Trigger labels recorded on pipeline_runs.trigger for observability. */
export type PipelineTrigger = 'manual' | 'auto-loop' | 'auto-run';

export interface DispatchPipelineOptions {
  cardsToGenerate: number;
  outputLanguage?: SupportedGenerationLanguage;
  trigger: PipelineTrigger;
}

export interface DispatchPipelineResult {
  pipelineRunId: string;
  subagentRunId: string;
  sessionKey: string;
}

/**
 * Build the agent prompt, dispatch the subagent, and durably record the run.
 * Does NOT wait for the agent — the caller can either poll waitForRun
 * synchronously (fast path) or hand off to the reconciler queue (slow path).
 */
export async function dispatchPipelineAgent(
  api: OpenClawPluginApi,
  opts: DispatchPipelineOptions,
): Promise<DispatchPipelineResult> {
  const currentDate = new Date().toISOString().slice(0, 10);
  const outputLanguage = opts.outputLanguage ?? DEFAULT_GENERATION_LANGUAGE;
  const pipelineRunId = `run_${opts.trigger}_${Date.now().toString(36)}`;

  const feedbackSummary = await loadFeedbackSummarySafe(api);
  const recentGeneratedCardsSummary = await loadRecentCardsSummarySafe(api);
  const learnedSkillsSection = await loadSkillsSectionSafe(api);

  let openSignalsBefore = 0;
  try {
    openSignalsBefore = await db.countPersonalSignals({ status: 'open' });
  } catch (err) {
    api.logger.warn(
      `[pipeline:dispatch] count open signals failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  api.logger.info(
    `[pipeline:dispatch] runId=${pipelineRunId} trigger=${opts.trigger} ` +
      `feedbackLoaded=${feedbackSummary.length > 0} ` +
      `cardsHistoryLoaded=${recentGeneratedCardsSummary.length > 0} ` +
      `skillsLoaded=${learnedSkillsSection.length > 0} ` +
      `openSignalCount=${openSignalsBefore}`,
  );

  const prompt = buildUnifiedGeneratorPrompt({
    currentDate,
    cardsToGenerate: opts.cardsToGenerate,
    recentFeedbackSummary: feedbackSummary,
    recentGeneratedCardsSummary,
    outputLanguage,
    learnedSkillsSection,
  });

  const dispatched = await dispatchAgent(
    api,
    'generate',
    prompt,
    "Gather the user's current context, generate intent cards, and self-review them. Output the final JSON.",
  );

  await db.savePipelineRunStart({
    runId: pipelineRunId,
    trigger: opts.trigger,
    subagentRunId: dispatched.runId,
    subagentSessionKey: dispatched.sessionKey,
  });

  api.logger.info(
    `[pipeline:dispatch] runId=${pipelineRunId} subagentRunId=${dispatched.runId} sessionKey=${dispatched.sessionKey}`,
  );

  return {
    pipelineRunId,
    subagentRunId: dispatched.runId,
    sessionKey: dispatched.sessionKey,
  };
}

interface UnifiedGeneratorOutput {
  reasoning?: string;
  cards?: Array<Record<string, unknown>>;
  evaluations?: Array<Record<string, unknown>>;
  batchFeedback?: string;
}

export interface FinalizePipelineResult {
  /** True when this call performed the UPDATE; false if the run was already terminal. */
  applied: boolean;
  finalCards: Array<Record<string, unknown>>;
}

/**
 * Parse the agent's text, score / select cards, and persist them. Safe to
 * call more than once for the same `pipelineRunId` — the UPDATE filters on
 * in-flight statuses so a duplicate from a re-queued reconciler is a no-op.
 *
 * Throws on parse / persist errors so the caller (route or handler) can
 * decide whether to mark the run failed or retry.
 */
export async function finalizePipelineRun(
  api: OpenClawPluginApi,
  pipelineRunId: string,
  agentText: string,
): Promise<FinalizePipelineResult> {
  const output = parseAgentJsonOrThrow<UnifiedGeneratorOutput>(agentText, 'generate');
  const cards = output.cards ?? [];
  // Empty cards is a valid agent decision, not an error — it means the
  // unified-generator finished context gathering and judged that no candidate
  // cleared the quality bar (typical for new users without connected
  // toolkits, or when the prompt's G3 genericness filter rejects every
  // option). We persist this as a completed run with `batchFeedback`
  // explaining why, so the frontend can show the user the agent's reasoning
  // instead of treating it as a generation failure.

  for (let j = 0; j < cards.length; j++) {
    cards[j]!['id'] = `${pipelineRunId}_${j + 1}`;
  }

  const evaluations = (output.evaluations ?? []) as Array<{
    cardId?: string;
    overall?: number;
    pass?: boolean;
    feedback?: string;
  }>;
  for (let j = 0; j < evaluations.length && j < cards.length; j++) {
    evaluations[j]!.cardId = cards[j]!['id'] as string;
  }

  const evaluation: Record<string, unknown> = {
    evaluations,
    batchFeedback: output.batchFeedback ?? '',
  };

  const allScoredCards: ScoredCard[] = cards.map((card) => {
    const cardId = card['id'] as string;
    const evalScore = evaluations.find((e) => e.cardId === cardId);
    return {
      card,
      score: {
        cardId,
        overall: evalScore?.overall ?? 7.0,
        pass: evalScore?.pass ?? true,
      },
    };
  });

  // Count over allScoredCards (one entry per generated card), not over the
  // evaluations array — when the agent emits fewer evaluations than cards,
  // missing rows fall through to score.pass=true (see the .find() above).
  // Counting evaluations directly produced misleading "generated=3 passed=2"
  // log lines where passed+rejected didn't sum to generated.
  const passedCount = allScoredCards.filter((entry) => entry.score.pass !== false).length;
  const rejectedCount = allScoredCards.length - passedCount;
  api.logger.info(
    `[pipeline:finalize] runId=${pipelineRunId} generated=${cards.length} passed=${passedCount} rejected=${rejectedCount}`,
  );

  const selectableCards = allScoredCards.filter((entry) => {
    const card = entry.card;
    if (!card || typeof card !== 'object') return true;
    return !isGenericHomeCalendarCard(card as Record<string, unknown>);
  });
  const suppressedCount = allScoredCards.length - selectableCards.length;
  if (suppressedCount > 0) {
    api.logger.info(
      `[pipeline:finalize] runId=${pipelineRunId} suppressedGenericHomeCalendar=${suppressedCount}`,
    );
  }

  const finalCards = selectBestCards(selectableCards);

  const scoreMap: Record<string, unknown> = {};
  for (const score of evaluations) {
    if (typeof score['cardId'] === 'string') {
      scoreMap[score['cardId'] as string] = score;
    }
  }

  const detailsPayload = {
    plan: { reasoning: output.reasoning ?? '' },
    cards,
    evaluation,
  };

  const updated = await db.markPipelineRunCompleted({
    runId: pipelineRunId,
    finalCards,
    details: detailsPayload,
  });
  if (updated === 0) {
    api.logger.info(
      `[pipeline:finalize] runId=${pipelineRunId} skipped — already terminal`,
    );
    return { applied: false, finalCards };
  }

  try {
    const cardSources: ScoredCardSource[] = finalCards
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        id: typeof c['id'] === 'string' ? (c['id'] as string) : '',
        goalBasket: typeof c['goalBasket'] === 'string' ? (c['goalBasket'] as string) : null,
        intentKey: typeof c['intentKey'] === 'string' ? (c['intentKey'] as string) : null,
      }))
      .filter((c) => c.id.length > 0);
    const evalRows = extractCardEvaluationsForRun(pipelineRunId, scoreMap, cardSources);
    if (evalRows.length > 0) {
      await db.saveCardEvaluations(evalRows);
    }
  } catch (err) {
    api.logger.warn(
      `[pipeline:finalize] persist card_evaluations failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Thread-match observability: tag selectable cards against existing intent
  // threads so we can see how often we collide with prior dismiss/hold
  // decisions. Logging only — does not affect ranking.
  await logThreadMatches(api, pipelineRunId, selectableCards);

  let openSignalsAfter = 0;
  try {
    openSignalsAfter = await db.countPersonalSignals({ status: 'open' });
    api.logger.info(
      `[pipeline:finalize] runId=${pipelineRunId} openSignalsAfter=${openSignalsAfter}`,
    );
  } catch (err) {
    api.logger.warn(
      `[pipeline:finalize] count open signals failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  api.logger.info(
    `[pipeline:finalize] runId=${pipelineRunId} status=completed cards=${finalCards.length}`,
  );
  if (finalCards.length === 0) {
    // Surface this case clearly so ops can distinguish "agent declined to
    // generate" from "agent failed". batchFeedback explains the why.
    const bf = (output.batchFeedback ?? '').slice(0, 200);
    api.logger.info(
      `[pipeline:finalize] runId=${pipelineRunId} agent declined to generate; batchFeedback="${bf}"`,
    );
  }

  return { applied: true, finalCards };
}

async function loadFeedbackSummarySafe(api: OpenClawPluginApi): Promise<string> {
  try {
    return formatRecentFeedbackSummary(await loadRecentFeedbackSummary());
  } catch (err) {
    api.logger.warn(
      `[pipeline:dispatch] feedback summary failed: ${err instanceof Error ? err.message : err}`,
    );
    return '';
  }
}

async function loadRecentCardsSummarySafe(api: OpenClawPluginApi): Promise<string> {
  try {
    return await loadRecentGeneratedCardsSummary({ limit: 10 });
  } catch (err) {
    api.logger.warn(
      `[pipeline:dispatch] recent cards summary failed: ${err instanceof Error ? err.message : err}`,
    );
    return '';
  }
}

async function loadSkillsSectionSafe(api: OpenClawPluginApi): Promise<string> {
  try {
    return await loadActiveSkillsSection();
  } catch (err) {
    api.logger.warn(
      `[pipeline:dispatch] skills section failed: ${err instanceof Error ? err.message : err}`,
    );
    return '';
  }
}

async function logThreadMatches(
  api: OpenClawPluginApi,
  pipelineRunId: string,
  selectableCards: ScoredCard[],
): Promise<void> {
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
      api.logger.warn(
        `[pipeline:finalize] thread context for ${intentKey} failed: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (context.threadDecision === 'hold' && context.latestCardOutcome === 'none') {
      continue;
    }
    api.logger.info(
      `[pipeline:thread-matches] runId=${pipelineRunId} cardId=${
        typeof card['id'] === 'string' ? card['id'] : ''
      } decision=${context.threadDecision} latestOutcome=${context.latestCardOutcome} ` +
        `score=${entry.score.overall} title="${title.slice(0, 80)}"`,
    );
  }
}

function isGenericHomeCalendarCard(card: Record<string, unknown>): boolean {
  const sources = Array.isArray(card.sources)
    ? card.sources.filter((item): item is string => typeof item === 'string')
    : [];
  const text = [card.title, card.whyNow, card.summary, ...sources]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
  const lower = text.toLowerCase();
  const hasHome = /\bhome\b/i.test(text);
  const hasCalendarSource = /gcal|calendar|google calendar|日历/.test(lower);
  const looksLikePlaceholder =
    /placeholder|all-day|占位|全天|连续|远程办公|休假|jun-jul|6月|7月|42\s*days/.test(lower);
  return hasHome && hasCalendarSource && looksLikePlaceholder;
}
