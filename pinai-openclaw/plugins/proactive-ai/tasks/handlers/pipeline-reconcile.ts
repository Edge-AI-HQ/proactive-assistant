/**
 * pipeline.reconcile handler — short-poll a previously-dispatched
 * unified-generator subagent and, when it finishes, finalize the
 * corresponding pipeline_run.
 *
 * Why this handler exists:
 *
 *   /generate (and the auto-loop) hand off to dispatchPipelineAgent(), which
 *   inserts pipeline_runs with status='running' and returns immediately.
 *   The route may try one synchronous wait (~90s) for the fast path; if
 *   that times out, it enqueues this handler. From here, we own the run
 *   until it's terminal — survives client disconnect, HTTP timeout, and
 *   process restart (the startup hook also re-enqueues stranded runs).
 *
 * Retry shape:
 *
 *   defaultBackoffForAttempt → 30s → 2m → 10m → 10m → 10m. With
 *   max_attempts=5 and the per-attempt 30s waitForRun, we cover roughly the
 *   first 22 minutes after dispatch. The handler also gates on
 *   PIPELINE_RUN_MAX_WAIT_MS (20 min from pipeline_runs.started_at) — once
 *   elapsed exceeds that, we mark the run failed even if more retries are
 *   nominally allowed, so an LLM that's wedged forever doesn't leak compute.
 *
 * "Still running" is signalled by returning status='failed' with code
 * 'reconcile_timeout'. That looks weird but it's the only way to ride the
 * scheduler's existing retry/backoff state machine without inventing a new
 * 'pending' terminal status. The pipeline_run itself stays in
 * 'reconciling', which is what the frontend reads to decide whether to keep
 * the indicator lit.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../../db.js';
import { collectAgentText } from '../../pipeline/agent-runner.js';
import { finalizePipelineRun } from '../../pipeline/dispatch-finalize.js';
import type { TaskHandler, TaskHandlerResult } from '../scheduler.js';

export const PIPELINE_RECONCILE_TASK_TYPE = 'pipeline.reconcile';

/** 20 minutes — hard cap on how long we'll wait for an agent before declaring it lost. */
export const PIPELINE_RUN_MAX_WAIT_MS = 20 * 60_000;

/** Per-attempt poll on subagent. Short so the lease doesn't expire. */
const POLL_TIMEOUT_MS = 30_000;

export interface PipelineReconcilePayload {
  pipelineRunId: string;
}

export interface PipelineReconcileDeps {
  api: OpenClawPluginApi;
}

export function pipelineReconcileIdempotencyKey(pipelineRunId: string): string {
  return `pipeline.reconcile:${pipelineRunId}:v1`;
}

export function createPipelineReconcileHandler(deps: PipelineReconcileDeps): TaskHandler {
  return async (ctx) => {
    const payload = (ctx.task.payload ?? {}) as Partial<PipelineReconcilePayload>;
    const pipelineRunId = typeof payload.pipelineRunId === 'string' ? payload.pipelineRunId : '';
    if (!pipelineRunId) {
      return failHard('bad_payload', 'pipeline.reconcile payload missing pipelineRunId');
    }

    const run = await db.getPipelineRun(pipelineRunId);
    if (!run) {
      return succeededWith({ skipped: 'run_not_found', pipelineRunId });
    }
    if (run.status !== 'running' && run.status !== 'reconciling') {
      return succeededWith({ skipped: 'already_terminal', pipelineRunId, status: run.status });
    }
    if (!run.subagent_run_id || !run.subagent_session_key) {
      await db.markPipelineRunFailed({
        runId: pipelineRunId,
        error: 'missing subagent metadata; cannot reconcile',
      });
      return succeededWith({ failed: 'missing_subagent_metadata', pipelineRunId });
    }

    const startedAtMs = Date.parse(run.started_at);
    const elapsedMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
    if (elapsedMs > PIPELINE_RUN_MAX_WAIT_MS) {
      await db.markPipelineRunFailed({
        runId: pipelineRunId,
        error: `exceeded max wait of ${PIPELINE_RUN_MAX_WAIT_MS}ms (elapsed=${elapsedMs}ms)`,
      });
      return succeededWith({
        failed: 'max_wait_exceeded',
        pipelineRunId,
        elapsedMs,
      });
    }

    // Once we're handling this run, expose 'reconciling' to the frontend
    // so the indicator can distinguish "primary wait still in flight" from
    // "we're queued and being polled."
    if (run.status === 'running') {
      await db.touchPipelineRunReconciling(pipelineRunId);
    }

    if (!(await ctx.heartbeat({ stage: 'polling' }))) {
      return failTransient('lease_lost', 'lease lost before subagent poll');
    }

    const result = await collectAgentText(deps.api, {
      runId: run.subagent_run_id,
      sessionKey: run.subagent_session_key,
      timeoutMs: POLL_TIMEOUT_MS,
    });

    if (result.status === 'ok' && result.text) {
      try {
        const finalized = await finalizePipelineRun(deps.api, pipelineRunId, result.text);
        return succeededWith({
          finalized: finalized.applied,
          pipelineRunId,
          cards: finalized.finalCards.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.api.logger.error(`[pipeline.reconcile] finalize failed runId=${pipelineRunId}: ${msg}`);
        await db.markPipelineRunFailed({ runId: pipelineRunId, error: `finalize: ${msg}` });
        return succeededWith({ failed: 'finalize_failed', pipelineRunId, error: msg });
      }
    }

    if (result.status === 'error') {
      await db.markPipelineRunFailed({
        runId: pipelineRunId,
        error: `subagent error: ${result.error ?? 'unknown'}`,
      });
      return succeededWith({
        failed: 'subagent_error',
        pipelineRunId,
        error: result.error ?? null,
      });
    }

    // status === 'timeout' — agent is still running. Lean on the framework's
    // retry / backoff loop to come back later.
    return failTransient(
      'reconcile_timeout',
      `subagent still running after ${POLL_TIMEOUT_MS}ms (elapsed=${elapsedMs}ms)`,
    );
  };
}

function failHard(code: string, message: string): TaskHandlerResult {
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function failTransient(code: string, message: string): TaskHandlerResult {
  // Same shape as failHard — the framework's backoff/max_attempts is what
  // turns repeated transient failures into a terminal 'failed'. We rely on
  // max_attempts=5 (set at enqueue time) to bound the retry envelope.
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function succeededWith(result: Record<string, unknown>): TaskHandlerResult {
  return { status: 'succeeded', result };
}
