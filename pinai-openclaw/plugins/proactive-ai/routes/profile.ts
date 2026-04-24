import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

const PROFILE_SNAPSHOT_PREVIEW_LIMIT = 12;
const PROFILE_INTEREST_PREVIEW_LIMIT = 24;

function personalSignalToProfileSignal(row: db.PersonalSignalRow) {
  return {
    id: row.id,
    user_id: 'local-user',
    kind: row.kind,
    target_type: row.kind,
    target_key: row.title,
    value: row.salience,
    source: row.source,
    context: {
      summary: row.summary,
      status: row.status,
      confidence: row.confidence,
      device_id: row.device_id,
      subject: row.subject,
      payload: row.payload,
    },
    occurred_at: row.occurred_at,
    created_at: row.ingested_at,
  };
}

export function handleProfile(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/profile')) return false;
    const route = ctx.subpath.slice('/profile'.length) || '/';

    try {
      if (route === '/goals' && ctx.req.method === 'GET') {
        json(ctx.res, 200, { ok: true, goals: await db.listGoals() });
        return true;
      }
      if (route === '/goals' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const key = String(body['key'] ?? '').trim();
        const title = String(body['title'] ?? '').trim();
        if (!key || !title) { json(ctx.res, 400, { error: 'Missing key or title' }); return true; }
        json(ctx.res, 200, { ok: true, data: await db.upsertGoal({ key, title, priority: String(body['priority'] ?? 'medium') }) });
        return true;
      }
      if (route === '/goals/close' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const key = String(body['key'] ?? '').trim();
        if (!key) { json(ctx.res, 400, { error: 'Missing key' }); return true; }
        json(ctx.res, 200, { ok: true, data: await db.closeGoal(key) });
        return true;
      }
      if (route === '/' && ctx.req.method === 'GET') {
        const [profile, goals, memories, personalSignals, interests] = await Promise.all([
          db.getProfile(),
          db.listGoals(),
          db.listMemories({ limit: PROFILE_SNAPSHOT_PREVIEW_LIMIT }),
          db.listPersonalSignals({
            status: 'open',
            until: new Date().toISOString(),
            limit: PROFILE_SNAPSHOT_PREVIEW_LIMIT,
            pruneExpired: true,
          }),
          db.listInterests({ limit: PROFILE_INTEREST_PREVIEW_LIMIT }),
        ]);
        const signals = personalSignals.map(personalSignalToProfileSignal);
        json(ctx.res, 200, { ok: true, profile, goals, memories, signals, interests });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    return false;
  };
}
