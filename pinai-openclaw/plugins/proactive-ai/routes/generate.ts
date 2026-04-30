/**
 * POST/GET /generate — kicks off a card generation run.
 *
 * Returns RESTful JSON instead of SSE. Two outcomes:
 *
 *   - 200 OK  { runId, status: 'completed', cards }
 *       Fast path: the subagent finished within FAST_PATH_WAIT_MS, we
 *       finalized inline. Frontend can render immediately or just refetch.
 *
 *   - 202 Accepted { runId, status: 'running' | 'reconciling' }
 *       Slow path: the subagent didn't return in time, we handed it off to
 *       the pipeline.reconcile background task. Frontend polls
 *       /runs/active and /runs/:id until it's terminal.
 *
 *   - 409 Conflict { error, runId }
 *       Another run (manual or auto-loop) is still in flight.
 *
 * The unified-generator is a single LLM call, so we don't expose any
 * intermediate progress — polling /runs/active is plenty for the indicator.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { RouteHandler } from './types.js';
import { json } from './types.js';
import { normalizeGenerationLanguage } from '../agents/generation-language.js';
import { isUnifiedGeneratorCompleteOutput } from '../agents/unified-generator.js';
import * as db from '../db.js';
import { syncCardChatFeedback } from '../chat-feedback/service.js';
import {
  dispatchPipelineAgent,
  finalizePipelineRun,
  type PipelineTrigger,
} from '../pipeline/dispatch-finalize.js';
import { collectAgentText } from '../pipeline/agent-runner.js';
import {
  PIPELINE_RECONCILE_TASK_TYPE,
  pipelineReconcileIdempotencyKey,
} from '../tasks/handlers/pipeline-reconcile.js';

/**
 * Inline wait for the fast path. 90s is short enough for the user to keep
 * the UI open without losing patience, long enough that the typical
 * unified-generator run (~60-180s) still completes inline often.
 */
const FAST_PATH_WAIT_MS = 90_000;

/**
 * The reconcile handler is now a long-running poll loop (single attempt
 * walks the agent to completion, see tasks/handlers/pipeline-reconcile.ts),
 * not a retry-with-backoff loop. `attempts` only increases when a reaper
 * sweep finds the lease expired — i.e. the worker process died mid-poll.
 * 2 attempts means "give a crashed run one fresh worker; if THAT also
 * dies, mark failed and stop wasting compute."
 */
const RECONCILE_MAX_ATTEMPTS = 2;

interface GenerateRouteDeps {
  getUserSettings?: typeof db.getUserSettings;
  syncCardChatFeedback?: typeof syncCardChatFeedback;
  /**
   * Called after enqueueing the pipeline.reconcile task so the scheduler
   * picks it up on the next tick instead of waiting out the default
   * tickIntervalMs (60s). See routes/router.ts RouterDeps.wakeScheduler.
   */
  wakeScheduler?: () => void;
}

export function handleGenerate(
  config: { cards_to_generate: number },
  deps?: GenerateRouteDeps,
): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/generate') return false;
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'POST') return false;

    return await runDispatch(ctx.api, ctx.res, {
      cardsToGenerate: config.cards_to_generate,
      trigger: 'manual',
      deps,
    });
  };
}

export interface AutoRunRouteDeps {
  getUserSettings?: typeof db.getUserSettings;
  syncCardChatFeedback?: typeof syncCardChatFeedback;
  wakeScheduler?: () => void;
}

/**
 * POST /auto-run — same lifecycle as /generate but tagged as 'auto-run'
 * trigger so dashboards can distinguish operator-initiated from
 * scheduler-initiated traffic.
 */
export function handleAutoRunDispatch(
  config: { cards_to_generate: number },
  deps?: AutoRunRouteDeps,
): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/auto-run' || ctx.req.method !== 'POST') return false;
    return await runDispatch(ctx.api, ctx.res, {
      cardsToGenerate: config.cards_to_generate,
      trigger: 'auto-run',
      deps,
    });
  };
}

async function runDispatch(
  api: OpenClawPluginApi,
  res: Parameters<RouteHandler>[0]['res'],
  params: {
    cardsToGenerate: number;
    trigger: PipelineTrigger;
    deps?: GenerateRouteDeps;
  },
): Promise<boolean> {
  const getUserSettings = params.deps?.getUserSettings ?? db.getUserSettings;
  const syncCardChatFeedbackImpl =
    params.deps?.syncCardChatFeedback ?? syncCardChatFeedback;

  const active = await db.getActivePipelineRun();
  if (active) {
    json(res, 409, {
      error: 'pipeline already running',
      runId: active.run_id,
      status: active.status,
    });
    return true;
  }

  const userSettings = await getUserSettings();
  const outputLanguage = normalizeGenerationLanguage(userSettings.generation_language);

  try {
    await syncCardChatFeedbackImpl({ api, trigger: 'pre_generate' });
  } catch (error) {
    api.logger.warn(
      `[generate] card chat feedback sync skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let dispatched: Awaited<ReturnType<typeof dispatchPipelineAgent>>;
  try {
    dispatched = await dispatchPipelineAgent(api, {
      cardsToGenerate: params.cardsToGenerate,
      outputLanguage,
      trigger: params.trigger,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[generate] dispatch failed: ${msg}`);
    json(res, 500, { error: `dispatch failed: ${msg}` });
    return true;
  }

  // Fast path — try to finish inline so simple cases don't pay polling latency.
  // validateFinal: even when waitForRun says ok, confirm the session jsonl
  // has a complete fenced JSON with at least one card. Catches the case
  // where waitForRun reports timeout long after the agent finished (the
  // OpenClaw in-memory wait registry race observed on dev) — the predicate
  // sees the final assistant turn and we return ok without waiting for the
  // reconciler.
  const collect = await collectAgentText(api, {
    runId: dispatched.subagentRunId,
    sessionKey: dispatched.sessionKey,
    timeoutMs: FAST_PATH_WAIT_MS,
    validateFinal: isUnifiedGeneratorCompleteOutput,
  });

  if (collect.status === 'ok' && collect.text) {
    try {
      const finalized = await finalizePipelineRun(
        api,
        dispatched.pipelineRunId,
        collect.text,
      );
      json(res, 200, {
        runId: dispatched.pipelineRunId,
        status: 'completed',
        cards: finalized.finalCards.length,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.error(
        `[generate] finalize failed runId=${dispatched.pipelineRunId}: ${msg}`,
      );
      await db.markPipelineRunFailed({
        runId: dispatched.pipelineRunId,
        error: `finalize: ${msg}`,
      });
      json(res, 500, {
        runId: dispatched.pipelineRunId,
        error: `finalize failed: ${msg}`,
      });
      return true;
    }
  }

  if (collect.status === 'error') {
    const errMsg = collect.error ?? 'subagent error';
    await db.markPipelineRunFailed({
      runId: dispatched.pipelineRunId,
      error: `subagent: ${errMsg}`,
    });
    json(res, 500, {
      runId: dispatched.pipelineRunId,
      error: `subagent: ${errMsg}`,
    });
    return true;
  }

  // collect.status === 'timeout' — hand off to the reconciler.
  try {
    await db.touchPipelineRunReconciling(dispatched.pipelineRunId);
    await db.enqueueBackgroundTask({
      type: PIPELINE_RECONCILE_TASK_TYPE,
      payload: { pipelineRunId: dispatched.pipelineRunId },
      idempotencyKey: pipelineReconcileIdempotencyKey(dispatched.pipelineRunId),
      // Run immediately; wake() below pulls it forward to the next tick
      // anyway, but using a past timestamp makes the intent explicit and
      // also handles the case where the scheduler isn't running (tests).
      runAfter: new Date().toISOString(),
      maxAttempts: RECONCILE_MAX_ATTEMPTS,
    });
    // Without this the scheduler waits out tickIntervalMs (60s default)
    // before claiming. The handler is a long-running polling loop so it'll
    // catch up either way, but waking shaves the worst-case "indicator
    // still spinning even though the agent is done" window from 60s to ~5s.
    params.deps?.wakeScheduler?.();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(
      `[generate] enqueue reconcile failed runId=${dispatched.pipelineRunId}: ${msg}`,
    );
    await db.markPipelineRunFailed({
      runId: dispatched.pipelineRunId,
      error: `enqueue reconcile: ${msg}`,
    });
    json(res, 500, {
      runId: dispatched.pipelineRunId,
      error: `enqueue reconcile failed: ${msg}`,
    });
    return true;
  }

  json(res, 202, {
    runId: dispatched.pipelineRunId,
    status: 'reconciling',
  });
  return true;
}
