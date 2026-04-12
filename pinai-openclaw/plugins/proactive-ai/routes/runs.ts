import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as db from '../db.js';

export function handleRuns(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/runs' || ctx.req.method !== 'GET') return false;
    const lastRun = await db.getLatestPipelineRun();
    json(ctx.res, 200, {
      ok: true,
      runs: lastRun ? [{ id: lastRun.run_id, completedAt: lastRun.completed_at, totalIterations: lastRun.total_iterations, finalCards: lastRun.final_cards, scoreMap: {} }] : [],
    });
    return true;
  };
}
