import { homedir } from 'node:os';
import { feedback as coreFeedback, CoreError } from '@pin-ai/core';
import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';

const ctx = { env: process.env, homeDir: homedir() };

export async function handleFeedback(routeCtx: RouteContext): Promise<boolean> {
  if (routeCtx.subpath !== '/feedback' || routeCtx.req.method !== 'POST') return false;

  try {
    const body = await readBody(routeCtx.req);
    const kind = String(body['kind'] ?? '').trim();
    if (!kind) {
      json(routeCtx.res, 400, { error: 'Missing kind' });
      return true;
    }

    const record = await coreFeedback.logFeedback(ctx, {
      kind,
      action: body['action'] ? String(body['action']) : undefined,
      intentCardId: body['intentCardId'] ? String(body['intentCardId']) : undefined,
      basket: body['basket'] ? String(body['basket']) : undefined,
      source: body['source'] ? String(body['source']) : 'user_direct',
    });

    json(routeCtx.res, 200, { ok: true, data: record });
  } catch (err) {
    if (err instanceof CoreError) {
      json(routeCtx.res, 400, { ok: false, error: { type: err.type, message: err.message } });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      json(routeCtx.res, 500, { error: msg });
    }
  }
  return true;
}
