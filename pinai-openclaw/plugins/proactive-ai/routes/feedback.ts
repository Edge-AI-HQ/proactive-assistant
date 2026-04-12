import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

export function handleFeedback(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath !== '/feedback' || ctx.req.method !== 'POST') return false;
    try {
      const body = await readBody(ctx.req);
      const kind = String(body['kind'] ?? '').trim();
      if (!kind) { json(ctx.res, 400, { error: 'Missing kind' }); return true; }
      const record = await db.logFeedback({
        kind, action: body['action'] as string | undefined,
        pushId: body['pushId'] as string | undefined,
        intentCardId: body['intentCardId'] as string | undefined,
        source: (body['source'] as string) ?? 'user_direct',
        basket: body['basket'] as string | undefined,
        value: body['value'] as string | undefined,
        text: body['text'] as string | undefined,
        metadata: body['metadata'] as Record<string, unknown> | undefined,
      });
      json(ctx.res, 200, { ok: true, data: record });
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
