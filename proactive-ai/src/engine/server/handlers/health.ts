import type { RouteContext } from '../types.js';
import { json } from '../http-utils.js';
import { pipelineState } from '../../state.js';
import { loadRunStore } from '../../pipeline/run-store.js';

export async function handleHealth(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = ctx;

  if (subpath === '/health' && req.method === 'GET') {
    json(res, 200, { ok: true, pipelineRunning: pipelineState.running });
    return true;
  }

  if (subpath === '/status' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      pipelineRunning: pipelineState.running,
      phase: pipelineState.phase,
      iteration: pipelineState.iteration,
      lastResult: loadRunStore().runs[0] ?? null,
    });
    return true;
  }

  return false;
}
