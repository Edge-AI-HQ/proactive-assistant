import type { RouteContext } from '../types.js';
import type { ServerEvent } from '../../../core/index.js';
import { json } from '../http-utils.js';
import { pipelineState } from '../../state.js';
import { DEFAULT_PIPELINE_OPTIONS } from '../../pipeline/orchestrator.js';
import { getGenerationLanguage } from '../local-settings.js';
import { executeIncrementalPipeline } from '../pipeline-runner.js';

export async function handleGenerate(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res, url, api } = ctx;
  if (subpath !== '/generate' || req.method !== 'GET') return false;

  if (pipelineState.running) {
    json(res, 409, { error: 'Pipeline is already running' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (event: ServerEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'pipeline:iteration') {
      pipelineState.phase = (event.data as { phase?: string }).phase ?? null;
      pipelineState.iteration = (event.data as { iteration?: number }).iteration ?? null;
    }
  };

  try {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const maxIter = parseInt(url.searchParams.get('iterations') ?? '', 10)
      || Number(pluginConfig['max_iterations'] ?? DEFAULT_PIPELINE_OPTIONS.maxIterations);
    const agentTimeoutMs = Number(pluginConfig['agent_timeout_ms'] ?? DEFAULT_PIPELINE_OPTIONS.agentTimeoutMs);
    const cardsPerIteration = Number(pluginConfig['cards_per_iteration'] ?? DEFAULT_PIPELINE_OPTIONS.cardsPerIteration ?? 8);
    const outputLanguage = getGenerationLanguage();

    const result = await executeIncrementalPipeline(api, {
      trigger: 'manual',
      maxIterations: maxIter,
      agentTimeoutMs,
      cardsPerIteration,
      onEvent: sendEvent,
      enforceCooldown: false,
      outputLanguage,
    });
    if ('skipped' in result) {
      if (result.skipped === 'no-pending') {
        sendEvent({ type: 'pipeline:error', data: { message: 'No incremental data available' } });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    api.logger.error(`Pipeline error: ${message}`);
    sendEvent({ type: 'pipeline:error', data: { message } });
  } finally {
    res.end();
  }

  return true;
}
