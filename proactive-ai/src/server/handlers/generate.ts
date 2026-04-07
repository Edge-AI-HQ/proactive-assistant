import type { RouteContext } from '../../types/server.js';
import type { ServerEvent } from '../../types/index.js';
import { json } from '../http-utils.js';
import { pipelineState } from '../../state.js';
import { saveRun } from '../../run-store.js';
import { runPipeline, DEFAULT_PIPELINE_OPTIONS } from '../../pipeline/orchestrator.js';

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

  pipelineState.running = true;

  try {
    const maxIter = parseInt(url.searchParams.get('iterations') ?? '', 10)
      || DEFAULT_PIPELINE_OPTIONS.maxIterations;

    const result = await runPipeline(
      api,
      { ...DEFAULT_PIPELINE_OPTIONS, maxIterations: maxIter },
      sendEvent,
    );

    saveRun({
      id: `run_${Date.now().toString(36)}`,
      completedAt: new Date().toISOString(),
      totalIterations: result.totalIterations,
      finalCards: result.finalCards,
      scoreMap: {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    api.logger.error(`Pipeline error: ${message}`);
    sendEvent({ type: 'pipeline:error', data: { message } });
  } finally {
    pipelineState.running = false;
    pipelineState.phase = null;
    pipelineState.iteration = null;
    res.end();
  }

  return true;
}
