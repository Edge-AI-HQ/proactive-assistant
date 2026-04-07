import type { RouteContext } from '../../types/server.js';
import { json } from '../http-utils.js';
import { loadRunStore } from '../../run-store.js';

export async function handleRuns(ctx: RouteContext): Promise<boolean> {
  if (ctx.subpath !== '/runs' || ctx.req.method !== 'GET') return false;
  json(ctx.res, 200, { ok: true, runs: loadRunStore().runs });
  return true;
}
