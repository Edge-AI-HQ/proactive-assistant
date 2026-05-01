/**
 * Auto-loop scheduler for the cloud proactive-ai plugin.
 *
 * Runs 3 concurrent timers:
 * 1. Auto-ingest: Periodically fetches world data (every 30min)
 * 2. Auto-detect-and-loop: Checks cooldown and triggers pipeline (every 5min)
 * 3. Auto-dreaming: Checks if dreaming is due (daily at 6am local) and triggers it (every 5min)
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../db.js';
import { dispatchPipelineAgent } from '../pipeline/dispatch-finalize.js';
import { normalizeGenerationLanguage } from '../agents/generation-language.js';
import { resolveDreamingTimezone, isDreamingDue, toDreamingLocalDayKey } from '../dreaming/schedule.js';
import { startDreaming, listDreamRuns } from '../dreaming/service.js';
import type { DreamRunRecord } from '../dreaming/types.js';
import { syncCardChatFeedback } from '../chat-feedback/service.js';
import { runCrystallize } from '../conversation-crystallize/service.js';
import { isBackgroundAutoLoopTasksEnabled } from '../shared/background-auto-loop-tasks.js';
import {
  PIPELINE_RECONCILE_TASK_TYPE,
  pipelineReconcileIdempotencyKey,
} from '../tasks/handlers/pipeline-reconcile.js';

/**
 * Same rationale as routes/generate.ts: the reconcile handler is a single
 * long-running poll loop, not a retry-with-backoff loop. attempts only
 * grows when the reaper finds a stale lease, which means the worker
 * crashed mid-poll. 2 attempts gives one fresh worker after a crash.
 */
const AUTO_LOOP_RECONCILE_MAX_ATTEMPTS = 2;

export interface AutoLoopConfig {
  auto_poll_enabled: boolean;
  auto_ingest_interval_ms: number;    // default 1_800_000 (30min)
  auto_detect_interval_ms: number;    // default 300_000 (5min)
  auto_loop_min_interval_ms: number;  // default 14_400_000 (4h cooldown)
  cards_to_generate: number;
  agent_timeout_ms: number;
}

export const DEFAULT_AUTO_LOOP_CONFIG: AutoLoopConfig = {
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 1_800_000,
  auto_detect_interval_ms: 300_000,
  auto_loop_min_interval_ms: 14_400_000,
  cards_to_generate: 8,
  agent_timeout_ms: 300_000,
};

export interface PipelineState {
  running: boolean;
  phase: string | null;
}

interface AutoLoopState {
  started: boolean;
  ingestTimer: ReturnType<typeof setInterval> | null;
  detectTimer: ReturnType<typeof setInterval> | null;
  ingestInFlight: boolean;
  loopInFlight: boolean;
  dreamInFlight: boolean;
  chatFeedbackInFlight: boolean;
  crystallizeInFlight: boolean;
  lastLoopFinishedAt: string | null;
  lastLoopStatus: string | null;
  /**
   * Lazy reference to the background-task scheduler's wake() entry point.
   * Set by startAutoLoop (closes over the module-level scheduler instance
   * in index.ts). Called after enqueueing pipeline.reconcile so the
   * scheduler claims it on the next tick instead of waiting out
   * tickIntervalMs.
   */
  wakeScheduler: (() => void) | null;
}

const state: AutoLoopState = {
  started: false,
  ingestTimer: null,
  detectTimer: null,
  ingestInFlight: false,
  loopInFlight: false,
  dreamInFlight: false,
  chatFeedbackInFlight: false,
  crystallizeInFlight: false,
  lastLoopFinishedAt: null,
  lastLoopStatus: null,
  wakeScheduler: null,
};

export function getAutoLoopState() { return { ...state }; }

// ── Helpers ──

function parseIsoTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getDreamRunLocalDayKey(run: DreamRunRecord, timezone: string): string | null {
  const timestamp = run.window_end || run.completed_at || run.started_at;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return toDreamingLocalDayKey(date, timezone);
}

// ── Auto-ingest ──

async function runIngest(api: OpenClawPluginApi, _config: AutoLoopConfig): Promise<void> {
  if (state.ingestInFlight) return;
  state.ingestInFlight = true;
  try {
    const { fetchWorldHeadlines } = await import('../world/ingest.js');
    const results = await fetchWorldHeadlines();
    const totalIngested = results.reduce((sum, r) => sum + r.ingested, 0);
    api.logger.info(
      `[auto-ingest] completed providers=${results.length} ingested=${totalIngested}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-ingest] failed: ${msg}`);
  } finally {
    state.ingestInFlight = false;
  }
}

// ── Auto-detect-and-loop ──

export async function runDetectAndLoop(
  api: OpenClawPluginApi,
  config: AutoLoopConfig,
  // pipelineState is retained as a parameter for backwards compatibility with
  // the existing caller signature, but we no longer trust an in-memory mutex —
  // db.getActivePipelineRun() is the single source of truth for "is something
  // running right now?" and survives process restart.
  _pipelineState: PipelineState,
): Promise<void> {
  if (state.loopInFlight) return;

  state.loopInFlight = true;
  try {
    // Check user setting
    const userSettings = await db.getUserSettings();
    if (!userSettings.auto_generate) {
      return;
    }

    // Check cooldown — keyed off the last successfully-dispatched auto-loop
    // tick, not pipeline finish, since the run is now durable and may still
    // be reconciling when the next tick fires.
    const lastFinishedMs = parseIsoTimestamp(state.lastLoopFinishedAt);
    const cooldownMs = Math.max(0, config.auto_loop_min_interval_ms);
    if (lastFinishedMs !== null && Date.now() - lastFinishedMs < cooldownMs) {
      api.logger.info(
        `[auto-loop] skipped: cooldown active waitMs=${cooldownMs - (Date.now() - lastFinishedMs)}`,
      );
      return;
    }

    // Concurrency guard sourced from DB so a manual /generate or a still-
    // reconciling prior auto-loop both block a fresh dispatch.
    const active = await db.getActivePipelineRun();
    if (active) {
      api.logger.info(
        `[auto-loop] skipped: pipeline_run ${active.run_id} status=${active.status} still in flight`,
      );
      return;
    }

    const outputLanguage = normalizeGenerationLanguage(userSettings.generation_language);

    let dispatched: Awaited<ReturnType<typeof dispatchPipelineAgent>>;
    try {
      dispatched = await dispatchPipelineAgent(api, {
        cardsToGenerate: config.cards_to_generate,
        outputLanguage,
        trigger: 'auto-loop',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastLoopFinishedAt = new Date().toISOString();
      state.lastLoopStatus = 'dispatch_failed';
      api.logger.error(`[auto-loop] dispatch failed: ${msg}`);
      return;
    }

    // Auto-loop is server-side: never wait inline. Hand off to the reconciler
    // immediately so the timer thread comes back fast and the per-tick
    // bookkeeping (lastLoopFinishedAt) reflects "we kicked off this run",
    // not "we waited for it to finish."
    try {
      await db.touchPipelineRunReconciling(dispatched.pipelineRunId);
      await db.enqueueBackgroundTask({
        type: PIPELINE_RECONCILE_TASK_TYPE,
        payload: { pipelineRunId: dispatched.pipelineRunId },
        idempotencyKey: pipelineReconcileIdempotencyKey(dispatched.pipelineRunId),
        runAfter: new Date().toISOString(),
        maxAttempts: AUTO_LOOP_RECONCILE_MAX_ATTEMPTS,
      });
      state.wakeScheduler?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.error(
        `[auto-loop] enqueue reconcile failed runId=${dispatched.pipelineRunId}: ${msg}`,
      );
      await db.markPipelineRunFailed({
        runId: dispatched.pipelineRunId,
        error: `enqueue reconcile: ${msg}`,
      });
      state.lastLoopFinishedAt = new Date().toISOString();
      state.lastLoopStatus = 'enqueue_failed';
      return;
    }

    state.lastLoopFinishedAt = new Date().toISOString();
    state.lastLoopStatus = 'dispatched';
    api.logger.info(
      `[auto-loop] dispatched runId=${dispatched.pipelineRunId} subagent=${dispatched.subagentRunId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastLoopFinishedAt = new Date().toISOString();
    state.lastLoopStatus = 'failed';
    api.logger.error(`[auto-loop] failed: ${msg}`);
  } finally {
    state.loopInFlight = false;
  }
}

// ── Auto-dreaming ──

/**
 * `opts.now` is test-only: it pins the wall clock the due-window check
 * sees, so unit tests aren't flaky depending on the host's real time of
 * day. Production callers leave it undefined.
 */
export async function runAutoDreaming(
  api: OpenClawPluginApi,
  opts?: { now?: Date },
): Promise<void> {
  if (state.dreamInFlight) return;

  // When background_tasks is enabled, dreaming is owned by
  // tasks/handlers/auto-dreaming.ts (enqueued by tasks/dreaming-enqueuer.ts).
  if (isBackgroundAutoLoopTasksEnabled()) return;

  state.dreamInFlight = true;
  try {
    // Check user setting
    const userSettings = await db.getUserSettings();
    if (!userSettings.auto_dreaming) {
      return;
    }

    // Get user profile timezone
    const profile = await db.getProfile();
    const profileTimezone = typeof profile?.timezone === 'string' ? profile.timezone : null;
    const timezone = resolveDreamingTimezone(
      profileTimezone,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );

    // Check last auto dream. A running same-day run also blocks duplicate
    // starts because this legacy path fire-and-forgets startDreaming().
    const runs = await listDreamRuns();
    const now = opts?.now ?? new Date();
    const currentDay = toDreamingLocalDayKey(now, timezone);
    const autoDreamAlreadyStartedToday = runs.some((run) => (
      run.trigger === 'auto' &&
      (run.status === 'running' || run.status === 'completed') &&
      getDreamRunLocalDayKey(run, timezone) === currentDay
    ));
    if (autoDreamAlreadyStartedToday) {
      return;
    }

    const lastAutoCompleted = runs.find((run) => run.trigger === 'auto' && run.status === 'completed');
    const lastAutoCompletedAt = lastAutoCompleted
      ? (lastAutoCompleted.window_end || lastAutoCompleted.completed_at)
      : null;

    if (!isDreamingDue({ now, timezone, lastAutoCompletedAt })) {
      return;
    }

    // Trigger dreaming
    const run = await startDreaming({ api, trigger: 'auto', now });
    api.logger.info(`[auto-dreaming] started runId=${run.id} timezone=${timezone}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-dreaming] failed: ${msg}`);
  } finally {
    state.dreamInFlight = false;
  }
}

interface AutoLoopChatFeedbackDeps {
  syncCardChatFeedback?: typeof syncCardChatFeedback;
}

// ── Auto-crystallize (main-chat conversation distillation) ──

export async function runAutoCrystallize(api: OpenClawPluginApi): Promise<void> {
  if (state.crystallizeInFlight) return;

  state.crystallizeInFlight = true;
  try {
    const userSettings = await db.getUserSettings();
    if (!userSettings.auto_crystallize) {
      return;
    }

    const result = await runCrystallize(api);
    if (!result.skipped) {
      api.logger.info(
        `[auto-crystallize] decision=${result.decision} salience=${(result.salience ?? 0).toFixed(2)}` +
        (result.memoryId ? ` memory=${result.memoryId}` : '') +
        (result.skillId ? ` skill=${result.skillId}` : ''),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-crystallize] failed: ${msg}`);
  } finally {
    state.crystallizeInFlight = false;
  }
}

export async function runAutoCardChatFeedback(
  api: OpenClawPluginApi,
  pipelineState: PipelineState,
  deps?: AutoLoopChatFeedbackDeps,
): Promise<void> {
  if (state.chatFeedbackInFlight) return;
  if (pipelineState.running) return;

  state.chatFeedbackInFlight = true;
  try {
    const syncCardChatFeedbackImpl = deps?.syncCardChatFeedback ?? syncCardChatFeedback;
    await syncCardChatFeedbackImpl({
      api,
      trigger: 'auto',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-chat-feedback] failed: ${msg}`);
  } finally {
    state.chatFeedbackInFlight = false;
  }
}

// ── Start / Stop ──

export interface AutoLoopDeps {
  /**
   * Wake the background-task scheduler after enqueueing
   * pipeline.reconcile. Optional — when omitted, the scheduler still
   * picks up the task on its next regular tick (default 60s), but
   * waking shaves the worst-case "agent done, indicator still spinning"
   * window. See routes/router.ts RouterDeps.wakeScheduler.
   */
  wakeScheduler?: () => void;
}

export function startAutoLoop(
  api: OpenClawPluginApi,
  config: AutoLoopConfig,
  pipelineState: PipelineState,
  deps: AutoLoopDeps = {},
): void {
  if (!config.auto_poll_enabled) {
    api.logger.info('[auto-loop] disabled by config');
    return;
  }
  if (state.started) return;
  state.started = true;
  state.wakeScheduler = deps.wakeScheduler ?? null;

  // Do not run ingest on cold start. Gateway readiness and user reconnects
  // should not wait behind slow external RSS/network fetches.
  state.ingestTimer = setInterval(() => {
    void runIngest(api, config);
  }, config.auto_ingest_interval_ms);

  // Start detect timer (runs both detect-and-loop and auto-dreaming)
  state.detectTimer = setInterval(() => {
    void runDetectAndLoop(api, config, pipelineState);
    void runAutoCardChatFeedback(api, pipelineState);
    void runAutoDreaming(api);
    void runAutoCrystallize(api);
  }, config.auto_detect_interval_ms);

  api.logger.info(
    `[auto-loop] started ingest=${config.auto_ingest_interval_ms}ms detect=${config.auto_detect_interval_ms}ms cooldown=${config.auto_loop_min_interval_ms}ms`,
  );
}

export function stopAutoLoop(): void {
  if (state.ingestTimer) {
    clearInterval(state.ingestTimer);
    state.ingestTimer = null;
  }
  if (state.detectTimer) {
    clearInterval(state.detectTimer);
    state.detectTimer = null;
  }
  state.started = false;
  state.ingestInFlight = false;
  state.loopInFlight = false;
  state.dreamInFlight = false;
  state.chatFeedbackInFlight = false;
  state.crystallizeInFlight = false;
  state.lastLoopFinishedAt = null;
  state.lastLoopStatus = null;
}
