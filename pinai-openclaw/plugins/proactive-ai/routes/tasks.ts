/**
 * Read-only HTTP surface for the background_tasks queue.
 *
 * Used by the Data Connections UI to poll a connector.init task's
 * progress after /composio/wait returns an initTaskId. The internal
 * `PIN_CLI_SURFACE=internal pin tasks` CLI is the write-side surface
 * (cancel, enqueue) — this route is
 * deliberately read-only so the UI can't accidentally mutate the queue.
 *
 * Endpoints:
 *   GET /tasks/:id            → 200 { task } | 404
 *   GET /tasks?type=...&status=...&limit=...&since=...
 *                             → 200 { count, tasks }
 *
 * Auth: registered under the same `/proactive-ai/api/*` prefix as the
 * rest of the plugin, which is gateway-authed at registration time
 * (see index.ts). No additional auth needed here.
 */
import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as db from '../db.js';

const VALID_STATUSES = new Set([
  'queued', 'running', 'succeeded', 'failed',
  'timed_out', 'cancelled', 'lost', 'skipped',
]);

export function handleTasks(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/tasks')) return false;
    if (ctx.req.method !== 'GET') return false;

    const route = ctx.subpath.slice('/tasks'.length); // '' or '/<id>' or '?...'

    // GET /tasks/:id
    if (route.startsWith('/')) {
      const taskId = route.slice(1).trim();
      if (!taskId) {
        json(ctx.res, 400, { error: 'Missing task id' });
        return true;
      }
      const task = await db.getBackgroundTask(taskId);
      if (!task) {
        json(ctx.res, 404, { error: `Task ${taskId} not found` });
        return true;
      }
      json(ctx.res, 200, { task });
      return true;
    }

    // GET /tasks (list, filtered)
    const params = ctx.url.searchParams;
    const type = params.get('type') ?? undefined;
    const statusRaw = params.get('status');
    const since = params.get('since') ?? undefined;
    const limitRaw = params.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && !Number.isFinite(limit)) {
      json(ctx.res, 400, { error: 'Invalid limit (must be a number)' });
      return true;
    }

    let status: db.BackgroundTaskStatus | db.BackgroundTaskStatus[] | undefined;
    if (statusRaw) {
      const parts = statusRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (!VALID_STATUSES.has(p)) {
          json(ctx.res, 400, { error: `Invalid status "${p}"` });
          return true;
        }
      }
      status = parts.length === 1
        ? parts[0]! as db.BackgroundTaskStatus
        : parts as db.BackgroundTaskStatus[];
    }

    const tasks = await db.listBackgroundTasks({ type, status, since, limit });
    json(ctx.res, 200, { count: tasks.length, tasks });
    return true;
  };
}
