import type { RouteHandler } from './types.js';
import { json } from './types.js';
import { listDreamRuns, getDreamRunDetail, startDreaming } from '../dreaming/service.js';

export function handleDreaming(): RouteHandler {
  return async (ctx) => {
    // GET /dreaming/runs -- list dream runs
    if (ctx.subpath === '/dreaming/runs' && ctx.req.method === 'GET') {
      const runs = await listDreamRuns();
      json(ctx.res, 200, { ok: true, runs });
      return true;
    }

    // POST /dreaming/run -- trigger new dream
    if (ctx.subpath === '/dreaming/run' && ctx.req.method === 'POST') {
      const run = await startDreaming({ api: ctx.api, trigger: 'manual' });
      json(ctx.res, 202, { ok: true, runId: run.id, status: run.status });
      return true;
    }

    // GET /dreaming/runs/:id -- get dream detail
    const detailMatch = ctx.subpath.match(/^\/dreaming\/runs\/([^/]+)$/);
    if (detailMatch && ctx.req.method === 'GET') {
      const detail = await getDreamRunDetail(detailMatch[1]!);
      if (!detail) { json(ctx.res, 404, { ok: false, error: 'Dream run not found' }); return true; }
      json(ctx.res, 200, { ok: true, run: detail.run, detail: detail.detail });
      return true;
    }

    // Phase 2a: dreams write through during executeDreamingForRun, so
    // there's no longer an "apply" step. Any stale frontend that still
    // POSTs here should fail loud rather than silently succeed.
    if (ctx.subpath.match(/^\/dreaming\/runs\/[^/]+\/apply-(profile|goals)$/)
        && ctx.req.method === 'POST') {
      json(ctx.res, 410, {
        ok: false,
        error: 'endpoint removed',
        hint: 'Dreams now apply directly during the run (no separate Apply step). Inspect run.applied_at / run.goals_applied_at to confirm.',
      });
      return true;
    }

    return false;
  };
}
