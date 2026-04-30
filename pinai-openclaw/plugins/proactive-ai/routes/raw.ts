/**
 * v3 raw.db read routes (no writes — connector / device adapters write directly).
 *
 *   GET /raw/gmail            ?since / ?until / ?threadId / ?limit
 *   GET /raw/gcal             ?since / ?until / ?calendarId / ?limit
 *   GET /raw/device-apps      ?deviceId / ?snapshotId / ?latestSnapshotOnly=1 / ?since / ?until / ?limit
 *   GET /raw/device-contacts  ?deviceId / ?snapshotId / ?latestSnapshotOnly=1 / ?since / ?until / ?search / ?limit
 *   GET /raw/device-health    ?deviceId / ?observationType / ?metric / ?localDate / ?since / ?until / ?limit
 *
 * See docs/plans/memory-architecture.mdx §三 (raw.db).
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
        const opts = {
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          threadId: p.get('threadId') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        };
        const messages = raw.listGmailMessages(opts);
        const total = raw.countGmailMessages(opts);
        json(ctx.res, 200, { ok: true, messages, total });
        return true;
      }

      if (route === '/gcal' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const opts = {
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          calendarId: p.get('calendarId') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        };
        const events = raw.listGcalEvents(opts);
        const total = raw.countGcalEvents(opts);
        json(ctx.res, 200, { ok: true, events, total });
        return true;
      }

      if (route === '/device-apps' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const opts = {
          deviceId: p.get('deviceId') ?? undefined,
          snapshotId: p.get('snapshotId') ?? undefined,
          latestSnapshotOnly: p.get('latestSnapshotOnly') === '1',
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        };
        const apps = raw.listDeviceApps(opts);
        const total = raw.countDeviceApps(opts);
        json(ctx.res, 200, { ok: true, apps, total });
        return true;
      }

      if (route === '/device-contacts' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const opts = {
          deviceId: p.get('deviceId') ?? undefined,
          snapshotId: p.get('snapshotId') ?? undefined,
          latestSnapshotOnly: p.get('latestSnapshotOnly') === '1',
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          search: p.get('search') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        };
        const contacts = raw.listDeviceContacts(opts);
        const total = raw.countDeviceContacts(opts);
        json(ctx.res, 200, { ok: true, contacts, total });
        return true;
      }

      if (route === '/device-health' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const opts = {
          deviceId: p.get('deviceId') ?? undefined,
          observationType: p.get('observationType') ?? undefined,
          metric: p.get('metric') ?? undefined,
          localDate: p.get('localDate') ?? undefined,
          since: p.get('since') ?? undefined,
          until: p.get('until') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        };
        const observations = raw.listDeviceHealthObservations(opts);
        const total = raw.countDeviceHealthObservations(opts);
        json(ctx.res, 200, { ok: true, observations, total });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}
