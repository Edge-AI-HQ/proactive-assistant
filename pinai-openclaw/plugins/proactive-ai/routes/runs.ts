import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as db from '../db.js';

/**
 * Pipeline run query API.
 *
 *   GET /runs           — backwards-compat: latest completed run only.
 *   GET /runs/active    — single in-flight run ('running' or 'reconciling') or null.
 *                         Source of truth for the frontend "generating" indicator.
 *   GET /runs/:id       — detailed view of a specific run, including final cards
 *                         when status='completed'.
 */
export function handleRuns(): RouteHandler {
  return async (ctx) => {
    if (ctx.req.method !== 'GET') return false;

    if (ctx.subpath === '/runs') {
      const lastRun = await db.getLatestCompletedPipelineRun();
      json(ctx.res, 200, {
        ok: true,
        runs: lastRun
          ? [
              {
                id: lastRun.run_id,
                status: lastRun.status,
                completedAt: lastRun.completed_at,
                finalCards: lastRun.final_cards,
                scoreMap: {},
              },
            ]
          : [],
      });
      return true;
    }

    if (ctx.subpath === '/runs/active') {
      const active = await db.getActivePipelineRun();
      json(ctx.res, 200, {
        ok: true,
        run: active ? toRunSummary(active) : null,
      });
      return true;
    }

    if (ctx.subpath.startsWith('/runs/')) {
      const id = decodeURIComponent(ctx.subpath.slice('/runs/'.length));
      if (!id) {
        json(ctx.res, 400, { ok: false, error: 'missing run id' });
        return true;
      }
      const run = await db.getPipelineRun(id);
      if (!run) {
        json(ctx.res, 404, { ok: false, error: 'not found', runId: id });
        return true;
      }
      json(ctx.res, 200, {
        ok: true,
        run: toRunDetail(run),
      });
      return true;
    }

    return false;
  };
}

function toRunSummary(row: db.PipelineRunRow): Record<string, unknown> {
  return {
    id: row.run_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function toRunDetail(row: db.PipelineRunRow): Record<string, unknown> {
  return {
    id: row.run_id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    finalCards: row.final_cards,
    error: row.error,
  };
}
