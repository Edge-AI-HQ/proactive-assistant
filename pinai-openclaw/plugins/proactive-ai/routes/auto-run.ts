import type { RouteHandler } from './types.js';
import { json } from './types.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { normalizeGenerationLanguage } from '../agents/generation-language.js';
import * as db from '../db.js';
import { syncCardChatFeedback } from '../chat-feedback/service.js';

interface AutoRunRouteDeps {
  getUserSettings?: typeof db.getUserSettings;
  runPipeline?: typeof runPipeline;
  syncCardChatFeedback?: typeof syncCardChatFeedback;
}

export function handleAutoRun(
  state: { running: boolean; phase: string | null; iteration: number | null },
  config: { max_iterations: number; cards_per_iteration: number; agent_timeout_ms: number; auto_loop_min_interval_ms: number },
  deps?: AutoRunRouteDeps,
): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/auto-run' || ctx.req.method !== 'POST') return false;
    if (state.running) { json(ctx.res, 409, { ok: false, error: 'Pipeline is already running' }); return true; }

    state.running = true;
    state.phase = 'auto';
    try {
      const getUserSettings = deps?.getUserSettings ?? db.getUserSettings;
      const runPipelineImpl = deps?.runPipeline ?? runPipeline;
      const syncCardChatFeedbackImpl = deps?.syncCardChatFeedback ?? syncCardChatFeedback;
      const userSettings = await getUserSettings();
      const outputLanguage = normalizeGenerationLanguage(userSettings.generation_language);
      try {
        await syncCardChatFeedbackImpl({
          api: ctx.api,
          trigger: 'pre_generate',
        });
      } catch (error) {
        ctx.api.logger.warn(`[auto-run] card chat feedback sync skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = await runPipelineImpl(ctx.api, {
        maxIterations: config.max_iterations,
        cardsPerIteration: config.cards_per_iteration,
        agentTimeoutMs: config.agent_timeout_ms,
        outputLanguage,
      });
      json(ctx.res, 200, { ok: true, runId: result.runId, cards: result.finalCards.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`[auto-run] failed: ${message}`);
      json(ctx.res, 500, { ok: false, error: message });
    } finally {
      state.running = false;
      state.phase = null;
      state.iteration = null;
    }
    return true;
  };
}
