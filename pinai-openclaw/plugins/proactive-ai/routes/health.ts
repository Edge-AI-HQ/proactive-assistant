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
      const [active, lastRun, latestRuns] = await Promise.all([
        db.getActivePipelineRun(),
        db.getLatestCompletedPipelineRun(),
        db.listPipelineRuns({ limit: 1 }),
      ]);
      const latestRun = latestRuns[0] ?? null;
      const canRecoverLastResult =
        !active &&
        !!lastRun &&
        latestRun?.run_id === lastRun.run_id &&
        latestRun.status === 'completed';
      // Pull batchFeedback from the artifact so a frontend reloading on a
      // fresh device (no sessionStorage) can still explain why the latest
      // completed run produced 0 cards. Cheap — only fires on /status hits,
      // not on every poll. Returns null silently if the artifact is missing.
      const artifact = canRecoverLastResult && lastRun
        ? (db.readRunArtifact(lastRun.run_id) as
            | { evaluation?: { batchFeedback?: unknown } }
            | null)
        : null;
      const lastBatchFeedback =
        typeof artifact?.evaluation?.batchFeedback === 'string'
          ? artifact.evaluation.batchFeedback
          : null;
      json(ctx.res, 200, {
        ok: true,
        pipelineRunning: !!active,
        activeRun: active
          ? { id: active.run_id, status: active.status, startedAt: active.started_at }
          : null,
        latestRun: latestRun
          ? {
              id: latestRun.run_id,
              status: latestRun.status,
              trigger: latestRun.trigger,
              startedAt: latestRun.started_at,
              updatedAt: latestRun.updated_at,
              completedAt: latestRun.completed_at,
              error: latestRun.error,
            }
          : null,
        lastResult: canRecoverLastResult && lastRun
          ? {
              id: lastRun.run_id,
              status: lastRun.status,
              completedAt: lastRun.completed_at,
              finalCards: lastRun.final_cards,
              batchFeedback: lastBatchFeedback,
            }
          : null,
      });
      return true;
    }
    return false;
  };
}
