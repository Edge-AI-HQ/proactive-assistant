import type { RouteHandler } from './types.js';
import { json } from './types.js';
import { listDreamRuns, getDreamRun, getDreamRunDetail, startDreaming, applyDreamProfile, applyDreamGoals } from '../dreaming/service.js';

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

    // POST /dreaming/runs/:id/apply-profile
    const applyMatch = ctx.subpath.match(/^\/dreaming\/runs\/([^/]+)\/apply-profile$/);
    if (applyMatch && ctx.req.method === 'POST') {
      try {
        const run = await applyDreamProfile(applyMatch[1]!);
        json(ctx.res, 200, { ok: true, run });
      } catch (err) {
        json(ctx.res, 409, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // POST /dreaming/runs/:id/apply-goals
    const applyGoalsMatch = ctx.subpath.match(/^\/dreaming\/runs\/([^/]+)\/apply-goals$/);
    if (applyGoalsMatch && ctx.req.method === 'POST') {
      try {
        const run = await applyDreamGoals(applyGoalsMatch[1]!);
        json(ctx.res, 200, { ok: true, run });
      } catch (err) {
        json(ctx.res, 409, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    return false;
  };
}
