/**
 * v3 raw.db read routes (no writes — connector / device adapters write directly).
 *
 *   GET /raw/gmail            ?since / ?until / ?threadId / ?limit
 *   GET /raw/gcal             ?since / ?until / ?calendarId / ?limit
 *   GET /raw/device-apps      ?deviceId / ?latestSnapshotOnly=1 / ?limit
 *
 * See docs/memory-architecture.md §三 (raw.db).
 */
import type { RouteHandler } from './types.js';
import { json } from './types.js';
import * as raw from '../raw-db.js';

export function handleRaw(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/raw/')) return false;
    const route = ctx.subpath.slice('/raw'.length);

    try {
      if (route === '/gmail' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const messages = raw.listGmailMessages({
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          threadId: p.get('threadId') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        });
        json(ctx.res, 200, { ok: true, messages });
        return true;
      }

      if (route === '/gcal' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const events = raw.listGcalEvents({
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          calendarId: p.get('calendarId') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        });
        json(ctx.res, 200, { ok: true, events });
        return true;
      }

      if (route === '/device-apps' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const apps = raw.listDeviceApps({
          deviceId: p.get('deviceId') ?? undefined,
          snapshotId: p.get('snapshotId') ?? undefined,
          latestSnapshotOnly: p.get('latestSnapshotOnly') === '1',
          limit: limit !== null ? Number(limit) : undefined,
        });
        json(ctx.res, 200, { ok: true, apps });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}
