import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as db from '../db.js';

export function handleHealth(state: { running: boolean; phase: string | null; iteration: number | null }): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === '/health' && ctx.req.method === 'GET') {
      json(ctx.res, 200, { ok: true, pipelineRunning: state.running });
      return true;
    }
    if (ctx.subpath === '/status' && ctx.req.method === 'GET') {
      const lastRun = await db.getLatestPipelineRun();
      json(ctx.res, 200, {
        ok: true, pipelineRunning: state.running, phase: state.phase, iteration: state.iteration,
        lastResult: lastRun ? {
          id: lastRun.run_id, completedAt: lastRun.completed_at,
          totalIterations: lastRun.total_iterations, finalCards: lastRun.final_cards,
        } : null,
      });
      return true;
    }
    return false;
  };
}
