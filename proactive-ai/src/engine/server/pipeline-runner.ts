import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG } from '../config.js';
import { runPipeline, DEFAULT_PIPELINE_OPTIONS } from '../pipeline/orchestrator.js';
import { pinCliData, runPinCli } from '../pipeline/pin-cli.js';
import { saveRun } from '../pipeline/run-store.js';
import { pipelineState } from '../state.js';
import type { ServerEvent } from '../../core/index.js';
import { cards } from '../../core/index.js';
import { loadAutoLoopState, saveAutoLoopState } from '../pending-store.js';
import type { SupportedGenerationLanguage } from '../generation-language.js';

type EventSink = (event: ServerEvent) => void;
type TriggerKind = 'auto' | 'manual';

interface IncrementalContextPayload {
  runToken: string | null;
  generatedAt: string;
  items: {
    world: Array<Record<string, unknown>>;
    personal: Array<Record<string, unknown>>;
  };
  meta: {
    pendingCount: number;
    oldestPendingAt: string | null;
  };
}

function toIsoNow(): string {
  return new Date().toISOString();
}

function parseIsoTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function buildScoreMap(result: Awaited<ReturnType<typeof runPipeline>>): Record<string, unknown> {
  const scoreMap: Record<string, unknown> = {};
  for (const iteration of result.iterations) {
    for (const score of iteration.evaluation.evaluations) {
      scoreMap[score.cardId] = score;
    }
  }
  return scoreMap;
}

export async function executeIncrementalPipeline(
  api: OpenClawPluginApi,
  input: {
    trigger: TriggerKind;
    maxIterations?: number;
    agentTimeoutMs?: number;
    cardsPerIteration?: number;
    minAgeMs?: number;
    cooldownMs?: number;
    onEvent?: EventSink;
    enforceCooldown?: boolean;
    outputLanguage?: SupportedGenerationLanguage;
  },
): Promise<
  | { ok: true; skipped: 'no-pending' | 'cooldown'; pending: number; waitMs?: number }
  | { ok: true; runId: string; consumedPending: number; cards: number }
> {
  const maxIterations = input.maxIterations ?? DEFAULT_PIPELINE_OPTIONS.maxIterations;
  const agentTimeoutMs = input.agentTimeoutMs ?? DEFAULT_PIPELINE_OPTIONS.agentTimeoutMs;
  const cardsPerIteration = input.cardsPerIteration ?? DEFAULT_PIPELINE_OPTIONS.cardsPerIteration;
  const minAgeMs = Math.max(0, input.minAgeMs ?? 0);
  const cooldownMs = Math.max(0, input.cooldownMs ?? DEFAULT_CONFIG.auto_loop_min_interval_ms);
  const contextLimit = 200;

  const context = await pinCliData<IncrementalContextPayload>([
    'context',
    'incremental',
    '--limit',
    String(contextLimit),
    '--min-age-ms',
    String(minAgeMs),
  ]);

  if (!context.runToken) {
    return { ok: true, skipped: 'no-pending', pending: 0 };
  }

  if (input.enforceCooldown) {
    const loopState = loadAutoLoopState();
    const lastFinishedMs = parseIsoTimestamp(loopState.lastFinishedAt);
    if (lastFinishedMs !== null && Date.now() - lastFinishedMs < cooldownMs) {
      return {
        ok: true,
        skipped: 'cooldown',
        pending: context.meta.pendingCount,
        waitMs: Math.max(0, cooldownMs - (Date.now() - lastFinishedMs)),
      };
    }
  }

  pipelineState.running = true;
  pipelineState.phase = input.trigger;
  pipelineState.iteration = null;
  saveAutoLoopState({ lastStartedAt: toIsoNow() });

  try {
    const result = await runPipeline(
      api,
      {
        maxIterations,
        agentTimeoutMs,
        cardsPerIteration,
        runId: `run_${input.trigger}_${Date.now().toString(36)}`,
        outputLanguage: input.outputLanguage,
      },
      input.onEvent,
    );
    const nowIso = toIsoNow();
    const commitResult = await runPinCli(['loop', 'commit', '--run-token', context.runToken]);
    if (!commitResult.ok) {
      throw new Error(commitResult.error?.message ?? 'Failed to commit loop run token');
    }

    const consumedPending =
      (commitResult.data as { processedCount?: number } | null)?.processedCount ?? 0;

    await cards.recordGeneratedBatch(
      {
        env: process.env as Record<string, string | undefined>,
        homeDir: homedir(),
      },
      {
        runId: result.runId,
        generatedAt: nowIso,
        cards: result.finalCards,
      },
    );

    saveRun({
      id: result.runId,
      completedAt: nowIso,
      totalIterations: result.totalIterations,
      finalCards: result.finalCards,
      scoreMap: {
        trigger: input.trigger,
        consumedPending,
        ...buildScoreMap(result),
      },
      completionStatus: result.completionStatus,
      warnings: result.warnings,
    });
    saveAutoLoopState({ lastFinishedAt: nowIso, lastStatus: 'success' });

    return {
      ok: true,
      runId: result.runId,
      consumedPending,
      cards: result.finalCards.length,
    };
  } catch (error) {
    saveAutoLoopState({ lastFinishedAt: toIsoNow(), lastStatus: 'error' });
    throw error;
  } finally {
    pipelineState.running = false;
    pipelineState.phase = null;
    pipelineState.iteration = null;
  }
}
