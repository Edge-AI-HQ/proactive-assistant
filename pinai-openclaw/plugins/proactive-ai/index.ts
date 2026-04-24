/**
 * OpenClaw Plugin: Proactive AI Cloud
 *
 * Cloud-native proactive-ai engine plugin.
 * Runs inside per-user Fly Machines with local SQLite as the data layer.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { createApiHandler } from './routes/router.js';
import type { PipelineState, PluginConfig } from './routes/router.js';
import { registerBrowserTool } from './browser/tool.js';
import { startAutoLoop, type AutoLoopConfig } from './scheduler/auto-loop.js';
import { sweepStaleRunningDreams } from './dreaming/store.js';
import { BackgroundTaskScheduler } from './tasks/scheduler.js';
import { createConnectorInitHandler } from './tasks/handlers/connector-init.js';
import { createAutoDreamingHandler } from './tasks/handlers/auto-dreaming.js';
import { reconcileActiveConnectorAccounts } from './tasks/reconciler.js';
import { maybeEnqueueDailyDreaming } from './tasks/dreaming-enqueuer.js';
import * as db from './db.js';

const DEFAULT_CONFIG: PluginConfig = {
  max_iterations: 1,
  cards_per_iteration: 8,
  agent_timeout_ms: 300_000,
  auto_loop_min_interval_ms: 900_000,
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 300_000,
  auto_detect_interval_ms: 60_000,
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
      max_iterations: { type: 'number' as const, default: 1 },
      cards_per_iteration: { type: 'number' as const, default: 8 },
      agent_timeout_ms: { type: 'number' as const, default: 300_000 },
      auto_loop_min_interval_ms: { type: 'number' as const, default: 900_000 },
      auto_poll_enabled: { type: 'boolean' as const, default: true },
      auto_ingest_interval_ms: { type: 'number' as const, default: 300_000 },
      auto_detect_interval_ms: { type: 'number' as const, default: 60_000 },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<PluginConfig>),
    };

    const state: PipelineState = {
      running: false,
      phase: null,
      iteration: null,
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
    const apiHandler = createApiHandler(api, state, config);
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
        max_iterations: config.max_iterations,
        cards_per_iteration: config.cards_per_iteration,
        agent_timeout_ms: config.agent_timeout_ms,
      };
      // Delay scheduler start to give the system time to fully initialize
      setTimeout(() => {
        startAutoLoop(api, autoLoopConfig, state);
      }, 10_000);
    }

    // Background task scheduler — Phase A built the queue, Phase B wires
    // connector.init for Gmail + GCal, Phase C migrates auto.dreaming. Still
    // gated by BACKGROUND_AUTO_LOOP_TASKS_ENABLED so the existing setInterval-
    // based auto-loop above keeps running unchanged for users / envs that
    // haven't opted in. The legacy in-process runAutoDreaming honors the
    // same flag and returns early when it's set, so the two paths can never
    // double-trigger.
    // See docs/plans/2026-04-24-data-connector-init-tasks.mdx.
    if (!bgTaskScheduler && process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED === '1') {
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
      // Phase C: auto.dreaming handler. Pairs with the dreaming-enqueuer
      // periodic check below — enqueuer decides "is today's slot due?",
      // handler runs the dream when the scheduler claims the task.
      bgTaskScheduler.registerHandler('auto.dreaming', createAutoDreamingHandler({ api }));
      bgTaskScheduler.start();
      api.logger.info(`[bg-tasks] scheduler started (worker=${workerId}, handlers=connector.init,auto.dreaming)`);

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
    }

    api.logger.info(`Proactive AI Cloud ready (user=${userId.slice(0, 8)}…, routes: /proactive-ai/*)`);
  },
};

/** Test-only accessor for the background task scheduler instance. */
export function getBackgroundTaskSchedulerForTests(): BackgroundTaskScheduler | null {
  return bgTaskScheduler;
}

export default plugin;
