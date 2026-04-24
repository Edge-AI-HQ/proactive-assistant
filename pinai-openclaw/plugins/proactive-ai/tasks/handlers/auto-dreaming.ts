/**
 * Phase C — auto.dreaming task handler.
 *
 * Wraps runDreaming({ api, trigger: 'auto' }) so the scheduler tracks
 * the dream end-to-end via lease + heartbeat. Returns the dream run id
 * in result_json so `pin tasks show` can correlate task ↔ dream.
 *
 * Why runDreaming (await full) instead of startDreaming (fire and forget):
 * - lease must stay held until the dream actually completes
 * - terminal task status must reflect the dream's actual outcome
 * - retry policy (max_attempts) must apply to the real failure
 *
 * max_attempts is meant to be 1 at enqueue time — dream is expensive
 * and one failure shouldn't trigger a re-spend the same day. The
 * dreaming-enqueuer handles tomorrow's slot independently.
 *
 * Lease TTL must be wide enough for the longest dream we tolerate. Set
 * via BACKGROUND_TASK_LEASE_MS at the scheduler level (default 60s);
 * dream pipeline can take 3-5 min so production should bump this to
 * 600_000 (10 min) when enabling Phase C in real environments. The
 * heartbeat below extends the lease at every stage so a 60s default
 * still works in practice.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { TaskHandler, TaskHandlerResult } from '../scheduler.js';

const DREAM_HEARTBEAT_LEASE_MS = 600_000;  // 10 min per heartbeat

export interface AutoDreamingHandlerDeps {
  /** Production: pass api so the handler can call runDreaming(api, ...). */
  api?: OpenClawPluginApi;
  /**
   * Test injection. Bypasses the real dreaming pipeline.
   * When provided, wins over deps.api.
   */
  dreamRunner?: AutoDreamingRunner;
}

export type AutoDreamingRunner = () => Promise<AutoDreamingRunResult>;

export interface AutoDreamingRunResult {
  runId: string;
  candidatesGenerated?: number;
  durationMs?: number;
}

export function createAutoDreamingHandler(deps: AutoDreamingHandlerDeps): TaskHandler {
  return async (ctx) => {
    if (!deps.api && !deps.dreamRunner) {
      return failHard('no_runtime', 'auto-dreaming handler needs deps.api or deps.dreamRunner');
    }

    // Long heartbeat lease — dreaming can take minutes. The reaper won't
    // touch us as long as we stay under leaseDurationMs after the last
    // heartbeat. We heartbeat once at start (next bump happens at the
    // 'completed' marker below).
    if (!(await ctx.heartbeat({ stage: 'running' }, { leaseDurationMs: DREAM_HEARTBEAT_LEASE_MS }))) {
      return abortLeaseLost();
    }

    const startedAt = Date.now();
    let result: AutoDreamingRunResult;
    try {
      if (deps.dreamRunner) {
        result = await deps.dreamRunner();
      } else {
        // Lazy import to keep this module testable in isolation. dreaming/
        // pulls in a lot of agent/runtime code; we don't want it in the
        // handler unit-test path.
        const { runDreaming } = await import('../../dreaming/service.js');
        const dreamResult = await runDreaming({ api: deps.api!, trigger: 'auto' });
        result = {
          runId: dreamResult.run.id,
          candidatesGenerated: Array.isArray(dreamResult.detail?.candidates)
            ? dreamResult.detail.candidates.length : 0,
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`[auto.dreaming] failed: ${msg}`);
      return {
        status: 'failed',
        errorCode: 'dream_failed',
        errorMessage: truncate(msg, 800),
      };
    }

    return {
      status: 'succeeded',
      result: {
        runId: result.runId,
        candidatesGenerated: result.candidatesGenerated ?? 0,
        durationMs: result.durationMs ?? Date.now() - startedAt,
      },
    };
  };
}

function failHard(code: string, message: string): TaskHandlerResult {
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function abortLeaseLost(): TaskHandlerResult {
  return {
    status: 'failed',
    errorCode: 'lease_lost',
    errorMessage: 'lease lost before dream started',
  };
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 3) + '...' : s;
}
