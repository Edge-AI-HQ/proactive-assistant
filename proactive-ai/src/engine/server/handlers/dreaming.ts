import type { RouteContext } from "../types.js";
import { json } from "../http-utils.js";
import { buildDefaultCtx } from "../../pipeline/data-access.js";
import {
  applyDreamGoals,
  applyDreamProfile,
  getDreamRunDetail,
  listDreamRuns,
  startDreaming,
} from "../../dreaming/service.js";

const ctx = buildDefaultCtx();

export async function handleDreaming(routeCtx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = routeCtx;

  if (subpath === "/dreaming/runs" && req.method === "GET") {
    json(res, 200, { ok: true, runs: listDreamRuns(ctx) });
    return true;
  }

  if (subpath === "/dreaming/run" && req.method === "POST") {
    const run = await startDreaming({
      ctx,
      api: routeCtx.api,
      trigger: "manual",
    });
    json(res, 202, { ok: true, runId: run.id, status: run.status });
    return true;
  }

  const detailMatch = subpath.match(/^\/dreaming\/runs\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const detail = getDreamRunDetail(ctx, detailMatch[1]);
    if (!detail) {
      json(res, 404, { ok: false, error: "Dream run not found" });
      return true;
    }
    json(res, 200, { ok: true, run: detail.run, detail: detail.detail });
    return true;
  }

  const applyMatch = subpath.match(/^\/dreaming\/runs\/([^/]+)\/apply-profile$/);
  if (applyMatch && req.method === "POST") {
    try {
      const run = await applyDreamProfile({ ctx, runId: applyMatch[1] });
      json(res, 200, { ok: true, run });
    } catch (error) {
      json(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const applyGoalsMatch = subpath.match(/^\/dreaming\/runs\/([^/]+)\/apply-goals$/);
  if (applyGoalsMatch && req.method === "POST") {
    try {
      const run = await applyDreamGoals({ ctx, runId: applyGoalsMatch[1] });
      json(res, 200, { ok: true, run });
    } catch (error) {
      json(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}
