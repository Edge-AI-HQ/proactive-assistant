import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as db from '../db.js';

export function handleHealth(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === '/health' && ctx.req.method === 'GET') {
      const active = await db.getActivePipelineRun();
      json(ctx.res, 200, { ok: true, pipelineRunning: !!active });
      return true;
    }
    if (ctx.subpath === '/status' && ctx.req.method === 'GET') {
      const [active, lastRun] = await Promise.all([
        db.getActivePipelineRun(),
        db.getLatestPipelineRun(),
      ]);
      json(ctx.res, 200, {
        ok: true,
        pipelineRunning: !!active,
        activeRun: active
          ? { id: active.run_id, status: active.status, startedAt: active.started_at }
          : null,
        lastResult: lastRun
          ? {
              id: lastRun.run_id,
              status: lastRun.status,
              completedAt: lastRun.completed_at,
              finalCards: lastRun.final_cards,
            }
          : null,
      });
      return true;
    }
    return false;
  };
}
