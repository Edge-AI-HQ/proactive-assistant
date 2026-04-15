import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { RouteHandler } from './types.js';
import { json } from './types.js';
import { runPipeline } from '../pipeline/orchestrator.js';
import { DEFAULT_GENERATION_LANGUAGE } from '../agents/generation-language.js';
import * as db from '../db.js';
import { syncCardChatFeedback } from '../chat-feedback/service.js';

const LANGUAGE_MAP: Record<string, string> = {
  en: 'English', 'zh-Hans': '简体中文 (Chinese)', ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)', es: 'Español (Spanish)',
};

interface GenerateRouteDeps {
  getUserSettings?: typeof db.getUserSettings;
  runPipeline?: typeof runPipeline;
  syncCardChatFeedback?: typeof syncCardChatFeedback;
}

export function handleGenerate(
  state: { running: boolean; phase: string | null; iteration: number | null },
  config: { max_iterations: number; cards_per_iteration: number; agent_timeout_ms: number },
  deps?: GenerateRouteDeps,
): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/generate' || ctx.req.method !== 'GET') return false;
    if (state.running) { json(ctx.res, 409, { error: 'Pipeline is already running' }); return true; }

    ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const sendEvent = (event: { type: string; data: unknown }) => {
      try { ctx.res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* SSE write failure */ }
    };

    state.running = true;
    state.phase = 'manual';

    try {
      const getUserSettings = deps?.getUserSettings ?? db.getUserSettings;
      const runPipelineImpl = deps?.runPipeline ?? runPipeline;
      const syncCardChatFeedbackImpl = deps?.syncCardChatFeedback ?? syncCardChatFeedback;
      const maxIter = parseInt(ctx.url.searchParams.get('iterations') ?? '', 10) || config.max_iterations;
      const userSettings = await getUserSettings();
      const outputLanguage = (LANGUAGE_MAP[userSettings.generation_language] ? userSettings.generation_language : DEFAULT_GENERATION_LANGUAGE) as any;

      try {
        await syncCardChatFeedbackImpl({
          api: ctx.api,
          trigger: 'pre_generate',
        });
      } catch (error) {
        ctx.api.logger.warn(`Card chat feedback sync skipped: ${error instanceof Error ? error.message : String(error)}`);
      }

      const result = await runPipelineImpl(ctx.api, {
        maxIterations: maxIter,
        cardsPerIteration: config.cards_per_iteration,
        agentTimeoutMs: config.agent_timeout_ms,
        outputLanguage,
      }, sendEvent);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.api.logger.error(`Pipeline error: ${message}`);
      sendEvent({ type: 'pipeline:error', data: { message } });
    } finally {
      state.running = false;
      state.phase = null;
      state.iteration = null;
      ctx.res.end();
    }
    return true;
  };
}
