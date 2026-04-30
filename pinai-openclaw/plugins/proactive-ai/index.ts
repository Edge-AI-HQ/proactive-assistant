/**
 * OpenClaw Plugin: Proactive AI Cloud
 *
 * Cloud-native proactive-ai engine plugin.
 * Runs inside per-user Fly Machines with local SQLite as the data layer.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { createApiHandler } from './routes/router.js';
import type { PluginConfig } from './routes/router.js';
import { registerBrowserTool } from './browser/tool.js';
import { startAutoLoop, type AutoLoopConfig, type PipelineState } from './scheduler/auto-loop.js';
import { sweepStaleRunningDreams } from './dreaming/store.js';
import { BackgroundTaskScheduler } from './tasks/scheduler.js';
import { createConnectorInitHandler } from './tasks/handlers/connector-init.js';
import { createConnectorSyncHandler } from './tasks/handlers/connector-sync.js';
import { createAutoDreamingHandler } from './tasks/handlers/auto-dreaming.js';
import {
  createPipelineReconcileHandler,
  PIPELINE_RECONCILE_TASK_TYPE,
  pipelineReconcileIdempotencyKey,
} from './tasks/handlers/pipeline-reconcile.js';
import { reconcileActiveConnectorAccounts } from './tasks/reconciler.js';
import { maybeEnqueueDailyDreaming } from './tasks/dreaming-enqueuer.js';
import { enqueueDueConnectorSyncs } from './tasks/connector-sync-enqueuer.js';
import { isBackgroundAutoLoopTasksEnabled } from './shared/background-auto-loop-tasks.js';
import { collectAgentText } from './pipeline/agent-runner.js';
import { finalizePipelineRun } from './pipeline/dispatch-finalize.js';
import * as db from './db.js';

const DEFAULT_CONFIG: PluginConfig = {
  cards_to_generate: 8,
  agent_timeout_ms: 300_000,
  auto_loop_min_interval_ms: 14_400_000,
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 1_800_000,
  auto_detect_interval_ms: 300_000,
};

async function ensureDefaultProfile(api: OpenClawPluginApi): Promise<void> {
  const existing = await db.getProfile();
  if (existing) return;

  api.logger.info('Seeding default profile');
  await db.upsertProfile({
    displayName: 'User',
    locale: 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    summary: 'A busy professional balancing career, health, finances, and personal growth.',
  });

  const starterGoals = [
    { key: 'career-growth', title: 'Advance career and professional skills', priority: 'high' },
    { key: 'stay-healthy', title: 'Maintain consistent exercise and healthy habits', priority: 'medium' },
    { key: 'financial-plan', title: 'Grow savings and make smart financial decisions', priority: 'medium' },
    { key: 'learn-and-grow', title: 'Dedicate time to learning new skills and ideas', priority: 'medium' },
    { key: 'relationships', title: 'Stay connected with family and close friends', priority: 'medium' },
    { key: 'life-balance', title: 'Protect personal time and avoid burnout', priority: 'high' },
  ];

  for (const g of starterGoals) {
    await db.upsertGoal(g);
  }

  api.logger.info('Default profile seeded with 6 starter goals');
}

let initialized = false;
let profileSeeded = false;
let autoLoopStarted = false;
let bgTaskScheduler: BackgroundTaskScheduler | null = null;
let reconcilerTimer: ReturnType<typeof setInterval> | null = null;

const plugin = {
  id: 'proactive-ai-cloud',
  name: 'Proactive AI Cloud',
  description: 'Cloud-native proactive AI engine with local SQLite data layer',
  configSchema: {
    type: 'object' as const,
    properties: {
      cards_to_generate: { type: 'number' as const, default: 8 },
      agent_timeout_ms: { type: 'number' as const, default: 300_000 },
      auto_loop_min_interval_ms: { type: 'number' as const, default: 14_400_000 },
      auto_poll_enabled: { type: 'boolean' as const, default: true },
      auto_ingest_interval_ms: { type: 'number' as const, default: 1_800_000 },
      auto_detect_interval_ms: { type: 'number' as const, default: 300_000 },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<PluginConfig>),
    };

    // pipelineState is kept solely for legacy auto-loop helpers
    // (runAutoCardChatFeedback / runAutoDreaming) that still take it as a
    // parameter. The new generation path is sourced entirely from DB
    // (db.getActivePipelineRun()) so /generate, /auto-run, and the auto-loop
    // dispatcher do not consult this struct.
    const state: PipelineState = {
      running: false,
      phase: null,
    };

    if (!initialized) {
      api.logger.info('Proactive AI Cloud loading');
      initialized = true;
    }

    // Validate required env vars
    const userId = process.env.PROACTIVE_USER_ID;
    if (!userId) {
      api.logger.error('PROACTIVE_USER_ID not set — plugin disabled');
      return;
    }
    // Local SQLite — no external DB required.

    // Seed default profile on first load
    if (!profileSeeded) {
      profileSeeded = true;
      ensureDefaultProfile(api).catch(err => {
        api.logger.warn(`Failed to seed default profile: ${err instanceof Error ? err.message : err}`);
      });
    }

    // Register browser tool (Browserbase) if configured
    if (process.env.BROWSERBASE_API_KEY) {
      registerBrowserTool(api);
    }

    // Register HTTP routes
    const apiHandler = createApiHandler(api, config);
    api.registerHttpRoute({ path: '/proactive-ai/api', auth: 'gateway', match: 'prefix', replaceExisting: true, handler: apiHandler });
    api.registerHttpRoute({ path: '/proactive-ai/rpc', auth: 'plugin', match: 'prefix', replaceExisting: true, handler: apiHandler });

    // Sweep stale 'running' dream_runs left over by older builds (the
    // pre-fix startDreaming() created an orphan placeholder per click).
    // Best-effort — never block plugin start. Matches the
    // ensureDefaultProfile() fire-and-forget pattern above; register() is
    // synchronous so we cannot await here.
    sweepStaleRunningDreams().then((swept) => {
      if (swept > 0) {
        api.logger.info(`Marked ${swept} stale running dream_run(s) as failed at boot`);
      }
    }).catch((err) => {
      api.logger.warn(`sweepStaleRunningDreams failed: ${err instanceof Error ? err.message : err}`);
    });

    // Start auto-loop scheduler (after profile seed, routes registered)
    if (!autoLoopStarted) {
      autoLoopStarted = true;
      const autoLoopConfig: AutoLoopConfig = {
        auto_poll_enabled: config.auto_poll_enabled,
        auto_ingest_interval_ms: config.auto_ingest_interval_ms,
        auto_detect_interval_ms: config.auto_detect_interval_ms,
        auto_loop_min_interval_ms: config.auto_loop_min_interval_ms,
        cards_to_generate: config.cards_to_generate,
        agent_timeout_ms: config.agent_timeout_ms,
      };
      // Delay scheduler start to give the system time to fully initialize
      setTimeout(() => {
        startAutoLoop(api, autoLoopConfig, state);
      }, 10_000);
    }

    // Background task scheduler — Phase A built the queue, Phase B wires
    // connector.init for Gmail + GCal, Phase C migrates auto.dreaming. It is
    // on by default; set BACKGROUND_AUTO_LOOP_TASKS_ENABLED=0 to force the
    // legacy dreaming path. The legacy in-process runAutoDreaming honors the
    // same flag and returns early when this scheduler owns dreaming, so the
    // two paths can never double-trigger.
    // See docs/plans/2026-04-24-data-connector-init-tasks.mdx.
    if (!bgTaskScheduler && isBackgroundAutoLoopTasksEnabled()) {
      const workerId = `${process.env.HOSTNAME ?? 'host'}:${process.pid}:${userId.slice(0, 8)}`;
      bgTaskScheduler = new BackgroundTaskScheduler({
        workerId,
        tickIntervalMs: Number(process.env.BACKGROUND_TASK_TICK_MS ?? 60_000),
        leaseDurationMs: Number(process.env.BACKGROUND_TASK_LEASE_MS ?? 60_000),
        logger: {
          info: (msg) => api.logger.info(msg),
          warn: (msg) => api.logger.warn(msg),
          error: (msg) => api.logger.error(msg),
        },
      });
      // Phase B + B.1: connector.init handler with evolve agent.
      bgTaskScheduler.registerHandler('connector.init', createConnectorInitHandler({
        api,
        evolveTimeoutMs: Number(process.env.CONNECTOR_INIT_EVOLVE_TIMEOUT_MS ?? 60_000),
      }));
      // Phase D follow-up: connector.sync handler (incremental). Default 12h
      // cadence per CONNECTOR_SYNC_INTERVAL_MS — see connector-sync-enqueuer
      // wiring below. Reuses init's evolve agent timeout.
      bgTaskScheduler.registerHandler('connector.sync', createConnectorSyncHandler({
        api,
        evolveTimeoutMs: Number(process.env.CONNECTOR_INIT_EVOLVE_TIMEOUT_MS ?? 60_000),
      }));
      // Phase C: auto.dreaming handler. Pairs with the dreaming-enqueuer
      // periodic check below — enqueuer decides "is today's slot due?",
      // handler runs the dream when the scheduler claims the task.
      bgTaskScheduler.registerHandler('auto.dreaming', createAutoDreamingHandler({ api }));
      // Durable pipeline runs: short-poll waitForRun on a previously-
      // dispatched unified-generator subagent and finalize the run when it
      // returns. /generate (fast-path-timeout) and the auto-loop both enqueue
      // this. See tasks/handlers/pipeline-reconcile.ts.
      bgTaskScheduler.registerHandler(
        PIPELINE_RECONCILE_TASK_TYPE,
        createPipelineReconcileHandler({ api }),
      );
      bgTaskScheduler.start();
      api.logger.info(`[bg-tasks] scheduler started (worker=${workerId}, handlers=connector.init,connector.sync,auto.dreaming,pipeline.reconcile)`);

      // Startup recovery for stranded pipeline_runs: a prior process death
      // can leave rows stuck in 'running' / 'reconciling'. Best-effort
      // salvage by reading the subagent session directly (waitForRun would
      // hang against a stale runId because the gateway's in-memory wait
      // cache doesn't survive restart). If the agent finished writing
      // before the crash, finalizePipelineRun resurrects the cards.
      // Otherwise we mark the run failed and re-enqueue the reconciler in
      // case the actual subagent runtime is still alive (rare but cheap to
      // try).
      void recoverStrandedPipelineRuns(api).catch((err) => {
        api.logger.warn(
          `[pipeline:recover] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Reconciler: scan ACTIVE Composio connections on a slow loop so that
      // users who close the OAuth tab (and never trigger /composio/wait) still
      // get their data initialized. The reconciler only ENQUEUES tasks; the
      // scheduler above runs them. See tasks/reconciler.ts.
      const reconcilerIntervalMs = Number(
        process.env.CONNECTOR_INIT_RECONCILER_INTERVAL_MS ?? 600_000,  // 10min
      );
      const runReconciler = () => {
        reconcileActiveConnectorAccounts({}).then((report) => {
          if (report.failed) {
            api.logger.warn(`[reconciler] sweep failed: ${report.failedReason}`);
          } else if (report.enqueued > 0 || report.invalid > 0) {
            api.logger.info(
              `[reconciler] scanned=${report.scanned} enqueued=${report.enqueued} alreadyHandled=${report.alreadyHandled} invalid=${report.invalid}`,
            );
          }
        }).catch((err) => {
          api.logger.error(`[reconciler] threw: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      // Don't run at boot — wait one interval so we don't pile a Composio
      // call on top of the cold-start sequence.
      reconcilerTimer = setInterval(runReconciler, reconcilerIntervalMs);
      if (typeof reconcilerTimer.unref === 'function') reconcilerTimer.unref();
      api.logger.info(`[reconciler] scheduled every ${Math.round(reconcilerIntervalMs / 1000)}s`);

      // Phase C: dreaming-enqueuer. Cheap, idempotent — runs every minute
      // and only writes a row when "user has auto_dreaming on" + "past 06:00
      // local" + "no dream completed today" + "no auto.dreaming task already
      // queued for today's local day". The handler registered above runs the
      // task once it's claimed.
      const dreamEnqueuerIntervalMs = Number(
        process.env.DREAMING_ENQUEUER_INTERVAL_MS ?? 60_000,  // 1min, matches old auto-loop cadence
      );
      const runDreamEnqueuer = () => {
        maybeEnqueueDailyDreaming({}).then((report) => {
          if (report.reason === 'enqueued') {
            api.logger.info(`[auto-dreaming] enqueued ${report.taskId} for ${report.localDay} (${report.timezone})`);
          } else if (report.reason === 'enqueue_failed') {
            api.logger.warn(`[auto-dreaming] enqueue failed: ${report.errorMessage}`);
          }
          // setting_off / not_due / already_enqueued are silent; they fire
          // every minute and would otherwise spam the log.
        }).catch((err) => {
          api.logger.error(`[auto-dreaming] enqueuer threw: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      const dreamEnqueuerTimer = setInterval(runDreamEnqueuer, dreamEnqueuerIntervalMs);
      if (typeof dreamEnqueuerTimer.unref === 'function') dreamEnqueuerTimer.unref();
      api.logger.info(`[auto-dreaming] enqueuer scheduled every ${Math.round(dreamEnqueuerIntervalMs / 1000)}s`);

      // Phase D follow-up: connector-sync enqueuer. Scans ACTIVE Composio
      // accounts on a slow timer (default 5min), but the per-account gate
      // keyed off CONNECTOR_SYNC_INTERVAL_MS (default 12h) caps how often
      // any single account actually gets a sync task. Cheap if no account
      // is due. See tasks/connector-sync-enqueuer.ts for window math.
      const syncEnqueuerIntervalMs = Number(
        process.env.CONNECTOR_SYNC_ENQUEUER_INTERVAL_MS ?? 300_000,
      );
      const runSyncEnqueuer = () => {
        enqueueDueConnectorSyncs({}).then((report) => {
          if (report.failed) {
            api.logger.warn(`[connector-sync] enqueuer sweep failed: ${report.failedReason}`);
          } else if (report.enqueued > 0 || report.invalid > 0) {
            api.logger.info(
              `[connector-sync] scanned=${report.scanned} enqueued=${report.enqueued} alreadyHandled=${report.alreadyHandled} awaitingInit=${report.awaitingInit} invalid=${report.invalid}`,
            );
          }
        }).catch((err) => {
          api.logger.error(`[connector-sync] enqueuer threw: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      const syncEnqueuerTimer = setInterval(runSyncEnqueuer, syncEnqueuerIntervalMs);
      if (typeof syncEnqueuerTimer.unref === 'function') syncEnqueuerTimer.unref();
      api.logger.info(`[connector-sync] enqueuer scheduled every ${Math.round(syncEnqueuerIntervalMs / 1000)}s (sync interval = ${Math.round(Number(process.env.CONNECTOR_SYNC_INTERVAL_MS ?? 12 * 60 * 60 * 1000) / 1000)}s)`);
    }

    api.logger.info(`Proactive AI Cloud ready (user=${userId.slice(0, 8)}…, routes: /proactive-ai/*)`);
  },
};

/**
 * Best-effort recovery for pipeline_runs left in 'running' / 'reconciling'
 * by a prior process crash. For each stranded row:
 *
 *   1. Try collectAgentText with skipWait=true. The gateway's in-memory
 *      waitForRun cache doesn't survive restart, so a fresh wait would just
 *      hang for the full timeout. Reading the persisted session messages is
 *      the only way to salvage the agent's last words.
 *   2. If the JSON output is there → finalizePipelineRun (status=completed).
 *   3. Otherwise the in-process agent died with the previous boot —
 *      mark the run failed. (Re-enqueueing reconciler would just hang on
 *      waitForRun.)
 */
async function recoverStrandedPipelineRuns(api: OpenClawPluginApi): Promise<void> {
  const stranded = await db.listPipelineRunsByStatus(['running', 'reconciling']);
  if (stranded.length === 0) return;
  api.logger.info(`[pipeline:recover] found ${stranded.length} stranded run(s)`);

  for (const run of stranded) {
    if (!run.subagent_run_id || !run.subagent_session_key) {
      await db.markPipelineRunFailed({
        runId: run.run_id,
        error: 'startup recovery: missing subagent metadata',
      });
      api.logger.warn(`[pipeline:recover] runId=${run.run_id} missing subagent metadata; marked failed`);
      continue;
    }

    let salvaged = false;
    try {
      const collect = await collectAgentText(api, {
        runId: run.subagent_run_id,
        sessionKey: run.subagent_session_key,
        // Unused because skipWait=true, but the type still requires it.
        timeoutMs: 0,
        skipWait: true,
      });
      if (collect.status === 'ok' && collect.text) {
        try {
          const finalized = await finalizePipelineRun(api, run.run_id, collect.text);
          if (finalized.applied) {
            salvaged = true;
            api.logger.info(
              `[pipeline:recover] runId=${run.run_id} salvaged cards=${finalized.finalCards.length}`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `[pipeline:recover] runId=${run.run_id} finalize failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      api.logger.warn(
        `[pipeline:recover] runId=${run.run_id} collect failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (!salvaged) {
      await db.markPipelineRunFailed({
        runId: run.run_id,
        error: 'startup recovery: subagent state lost (process restart)',
      });
      api.logger.warn(`[pipeline:recover] runId=${run.run_id} could not salvage; marked failed`);
    }
  }
}

/** Test-only accessor for the background task scheduler instance. */
export function getBackgroundTaskSchedulerForTests(): BackgroundTaskScheduler | null {
  return bgTaskScheduler;
}

export default plugin;
