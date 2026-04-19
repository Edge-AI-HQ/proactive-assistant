/**
 * Auto-loop scheduler for the cloud proactive-ai plugin.
 *
 * Runs 3 concurrent timers:
 * 1. Auto-ingest: Periodically fetches world data (every 5min)
 * 2. Auto-detect-and-loop: Checks cooldown and triggers pipeline (every 1min)
 * 3. Auto-dreaming: Checks if dreaming is due (daily at 6am local) and triggers it (every 1min)
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../db.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { normalizeGenerationLanguage } from '../agents/generation-language.js';
import { resolveDreamingTimezone, isDreamingDue } from '../dreaming/schedule.js';
import { startDreaming, listDreamRuns } from '../dreaming/service.js';
import { syncCardChatFeedback } from '../chat-feedback/service.js';

export interface AutoLoopConfig {
  auto_poll_enabled: boolean;
  auto_ingest_interval_ms: number;    // default 300_000 (5min)
  auto_detect_interval_ms: number;    // default 60_000 (1min)
  auto_loop_min_interval_ms: number;  // default 900_000 (15min cooldown)
  max_iterations: number;
  cards_per_iteration: number;
  agent_timeout_ms: number;
}

export const DEFAULT_AUTO_LOOP_CONFIG: AutoLoopConfig = {
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 300_000,
  auto_detect_interval_ms: 60_000,
  auto_loop_min_interval_ms: 900_000,
  max_iterations: 1,
  cards_per_iteration: 8,
  agent_timeout_ms: 300_000,
};

export interface PipelineState {
  running: boolean;
  phase: string | null;
  iteration: number | null;
}

interface AutoLoopState {
  started: boolean;
  ingestTimer: ReturnType<typeof setInterval> | null;
  detectTimer: ReturnType<typeof setInterval> | null;
  ingestInFlight: boolean;
  loopInFlight: boolean;
  dreamInFlight: boolean;
  chatFeedbackInFlight: boolean;
  lastLoopFinishedAt: string | null;
  lastLoopStatus: string | null;
}

const state: AutoLoopState = {
  started: false,
  ingestTimer: null,
  detectTimer: null,
  ingestInFlight: false,
  loopInFlight: false,
  dreamInFlight: false,
  chatFeedbackInFlight: false,
  lastLoopFinishedAt: null,
  lastLoopStatus: null,
};

export function getAutoLoopState() { return { ...state }; }

// ── Helpers ──

function parseIsoTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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

async function runDetectAndLoop(
  api: OpenClawPluginApi,
  config: AutoLoopConfig,
  pipelineState: PipelineState,
): Promise<void> {
  if (state.loopInFlight) return;
  if (pipelineState.running) return;

  state.loopInFlight = true;
  try {
    // Check user setting
    const userSettings = await db.getUserSettings();
    if (!userSettings.auto_generate) {
      return;
    }

    // Check cooldown
    const lastFinishedMs = parseIsoTimestamp(state.lastLoopFinishedAt);
    const cooldownMs = Math.max(0, config.auto_loop_min_interval_ms);
    if (lastFinishedMs !== null && Date.now() - lastFinishedMs < cooldownMs) {
      api.logger.info(
        `[auto-loop] skipped: cooldown active waitMs=${cooldownMs - (Date.now() - lastFinishedMs)}`,
      );
      return;
    }

    // Run pipeline directly (no need for gateway HTTP since we're in the same process)
    const outputLanguage = normalizeGenerationLanguage(userSettings.generation_language);
    const result = await runPipeline(api, {
      maxIterations: config.max_iterations,
      cardsPerIteration: config.cards_per_iteration,
      agentTimeoutMs: config.agent_timeout_ms,
      outputLanguage,
    });

    state.lastLoopFinishedAt = new Date().toISOString();
    state.lastLoopStatus = 'completed';

    // Save pipeline run to DB
    await db.savePipelineRun({
      runId: result.runId,
      status: 'completed',
      totalIterations: result.totalIterations,
      finalCards: result.finalCards,
      iterations: [],
    });

    api.logger.info(
      `[auto-loop] completed runId=${result.runId} cards=${result.finalCards.length}`,
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

async function runAutoDreaming(api: OpenClawPluginApi): Promise<void> {
  if (state.dreamInFlight) return;

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

    // Check last auto-completed dream
    const runs = await listDreamRuns();
    const lastAutoCompletedAt =
      runs.find((run) => run.trigger === 'auto' && run.status === 'completed')?.completed_at ?? null;

    if (!isDreamingDue({
      now: new Date(),
      timezone,
      lastAutoCompletedAt,
    })) {
      return;
    }

    // Trigger dreaming
    const run = await startDreaming({ api, trigger: 'auto' });
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

export function startAutoLoop(
  api: OpenClawPluginApi,
  config: AutoLoopConfig,
  pipelineState: PipelineState,
): void {
  if (!config.auto_poll_enabled) {
    api.logger.info('[auto-loop] disabled by config');
    return;
  }
  if (state.started) return;
  state.started = true;

  // Run initial ingest immediately
  void runIngest(api, config);

  // Start ingest timer
  state.ingestTimer = setInterval(() => {
    void runIngest(api, config);
  }, config.auto_ingest_interval_ms);

  // Start detect timer (runs both detect-and-loop and auto-dreaming)
  state.detectTimer = setInterval(() => {
    void runDetectAndLoop(api, config, pipelineState);
    void runAutoCardChatFeedback(api, pipelineState);
    void runAutoDreaming(api);
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
  state.lastLoopFinishedAt = null;
  state.lastLoopStatus = null;
}
