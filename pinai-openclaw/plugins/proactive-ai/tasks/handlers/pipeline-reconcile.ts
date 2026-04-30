/**
 * pipeline.reconcile handler — long-running poll loop that walks a
 * dispatched unified-generator subagent to completion and finalizes the
 * corresponding pipeline_run.
 *
 * Design:
 *
 *   /generate (and the auto-loop) call dispatchPipelineAgent(), which
 *   inserts a pipeline_run row with status='running' and returns
 *   immediately. The route may try one synchronous fast-path wait
 *   (~90s); if it times out, this handler is enqueued and owns the run
 *   from there until terminal.
 *
 *   The handler is a *single* attempt that polls the agent's session
 *   jsonl every POLL_INTERVAL_MS, with periodic lease heartbeats. It
 *   does NOT use OpenClaw's `waitForRun` — that signal has been
 *   observed returning `timeout` 20+ minutes after the agent finished
 *   (production case 2026-04-30, run `run_manual_mokzougs`). The
 *   session jsonl is the source of truth: when
 *   `isUnifiedGeneratorCompleteOutput(text)` accepts the latest
 *   assistant turn, we finalize.
 *
 *   `attempts` in background_tasks no longer means "retry count." It
 *   only increments when the reaper finds a stale lease, i.e. the
 *   worker process died mid-poll. With max_attempts=2 (set at enqueue
 *   time in routes/generate.ts and scheduler/auto-loop.ts), one crash
 *   gets a fresh worker; a second crash terminates the task. The hard
 *   cap PIPELINE_RUN_MAX_WAIT_MS protects against an LLM that runs
 *   forever; before giving up at the boundary we make one last
 *   validate-and-finalize attempt in case the agent finished while we
 *   were sleeping.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../../db.js';
import { collectAgentText } from '../../pipeline/agent-runner.js';
import { finalizePipelineRun } from '../../pipeline/dispatch-finalize.js';
import { isUnifiedGeneratorCompleteOutput } from '../../agents/unified-generator.js';
import type { TaskHandler, TaskHandlerContext, TaskHandlerResult } from '../scheduler.js';

export const PIPELINE_RECONCILE_TASK_TYPE = 'pipeline.reconcile';

/** 20 minutes — hard cap on how long we'll wait for an agent before declaring it lost. */
export const PIPELINE_RUN_MAX_WAIT_MS = 20 * 60_000;

/**
 * Sleep between polls. 5s is a good fit for `unified-generator` runs
 * (typically 30–180s): worst-case end-to-end latency from "agent wrote
 * final JSON" to "pipeline_run completed" is one POLL_INTERVAL_MS plus
 * the IO of reading 10 last messages and running the validator
 * (a few ms). Ten polls per minute reads ~10 jsonl tails per minute,
 * which is well under any rate-of-concern.
 */
const POLL_INTERVAL_MS = 5_000;

export interface PipelineReconcilePayload {
  pipelineRunId: string;
}

export interface PipelineReconcileDeps {
  api: OpenClawPluginApi;
  /** Test seam — overridable so tests don't sleep real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — overridable so tests can advance fake time. */
  now?: () => number;
}

export function pipelineReconcileIdempotencyKey(pipelineRunId: string): string {
  return `pipeline.reconcile:${pipelineRunId}:v1`;
}

export function createPipelineReconcileHandler(deps: PipelineReconcileDeps): TaskHandler {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

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

    // Surface 'reconciling' so the frontend indicator can distinguish
    // "primary wait still in flight" from "background polling now owns it."
    if (run.status === 'running') {
      await db.touchPipelineRunReconciling(pipelineRunId);
    }

    const startedAtMs = Date.parse(run.started_at);
    const startedAtValid = Number.isFinite(startedAtMs);
    const elapsed = () => (startedAtValid ? now() - startedAtMs : 0);

    let polls = 0;
    while (elapsed() <= PIPELINE_RUN_MAX_WAIT_MS) {
      // Heartbeat first so a lost lease aborts before we burn IO. Update
      // progress on every tick — `pin tasks show` reflects the latest poll
      // for free.
      const alive = await ctx.heartbeat({
        stage: 'polling',
        polls,
        elapsedMs: elapsed(),
      });
      if (!alive) {
        return failTransient('lease_lost', `lease lost after ${polls} polls`);
      }

      const probe = await pollSession(deps.api, run, pipelineRunId);
      polls += 1;
      if (probe.kind === 'ok') {
        return probe.result;
      }
      if (probe.kind === 'error') {
        return probe.result;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    // Hard cap reached. One last read in case the agent finished
    // somewhere inside the final sleep — cheap insurance against a
    // boundary miss.
    const lastChance = await pollSession(deps.api, run, pipelineRunId);
    if (lastChance.kind === 'ok' || lastChance.kind === 'error') {
      return lastChance.result;
    }
    await db.markPipelineRunFailed({
      runId: pipelineRunId,
      error: `exceeded max wait of ${PIPELINE_RUN_MAX_WAIT_MS}ms (elapsed=${elapsed()}ms)`,
    });
    return succeededWith({
      failed: 'max_wait_exceeded',
      pipelineRunId,
      elapsedMs: elapsed(),
      polls,
    });
  };
}

interface PollOutcome {
  kind: 'ok' | 'error' | 'continue';
  /** Present when kind ∈ {'ok','error'} — the value to return from the handler. */
  result?: TaskHandlerResult;
}

/**
 * Single poll iteration: read the session jsonl, validate against the
 * unified-generator completion schema, finalize / markFailed when
 * conclusive. Returns 'continue' when the agent is still mid-flight.
 *
 * Extracted so both the main loop and the boundary last-chance path
 * share exactly one definition of "what happens when we read the
 * session" — keeps "still running" and "definitely done" decisions
 * honest with each other.
 */
async function pollSession(
  api: OpenClawPluginApi,
  run: db.PipelineRunRow,
  pipelineRunId: string,
): Promise<PollOutcome> {
  const result = await collectAgentText(api, {
    runId: run.subagent_run_id!,
    sessionKey: run.subagent_session_key!,
    // skipWait: the session jsonl is the source of truth, and waitForRun
    // adds latency without adding information (timeoutMs unused under skipWait).
    timeoutMs: 0,
    skipWait: true,
    validateFinal: isUnifiedGeneratorCompleteOutput,
  });

  if (result.status === 'ok' && result.text) {
    try {
      const finalized = await finalizePipelineRun(api, pipelineRunId, result.text);
      return {
        kind: 'ok',
        result: succeededWith({
          finalized: finalized.applied,
          pipelineRunId,
          cards: finalized.finalCards.length,
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.error(`[pipeline.reconcile] finalize failed runId=${pipelineRunId}: ${msg}`);
      await db.markPipelineRunFailed({ runId: pipelineRunId, error: `finalize: ${msg}` });
      return {
        kind: 'error',
        result: succeededWith({ failed: 'finalize_failed', pipelineRunId, error: msg }),
      };
    }
  }

  if (result.status === 'error') {
    await db.markPipelineRunFailed({
      runId: pipelineRunId,
      error: `subagent error: ${result.error ?? 'unknown'}`,
    });
    return {
      kind: 'error',
      result: succeededWith({
        failed: 'subagent_error',
        pipelineRunId,
        error: result.error ?? null,
      }),
    };
  }

  // 'timeout' = still running. Loop will sleep and re-poll.
  return { kind: 'continue' };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function failHard(code: string, message: string): TaskHandlerResult {
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function failTransient(code: string, message: string): TaskHandlerResult {
  // The reaper requeues a 'failed' task while attempts < max_attempts.
  // We use this only for "lease lost mid-poll" — see the doc block at the
  // top of the file. With max_attempts=2 set at enqueue, a single crashed
  // worker gets a second chance; a second crash terminates the task.
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function succeededWith(result: Record<string, unknown>): TaskHandlerResult {
  return { status: 'succeeded', result };
}

// Re-exports for tests
export type { TaskHandlerContext };
