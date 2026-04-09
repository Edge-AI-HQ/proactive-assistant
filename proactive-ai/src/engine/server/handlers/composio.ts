import type { RouteContext } from '../types.js';
import { json, readBody } from '../http-utils.js';
import { personal as corePersonal, CoreError } from '../../../core/index.js';
import { buildDefaultCtx } from '../../pipeline/data-access.js';

const ctx = buildDefaultCtx();

export async function handleComposio(routeCtx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = routeCtx;
  if (!subpath.startsWith('/composio/')) return false;

  const route = subpath.slice('/composio'.length);
  const personalAny = corePersonal as Record<string, (...args: unknown[]) => Promise<unknown>>;

  try {
    // GET /composio/status
    if (route === '/status' && req.method === 'GET') {
      const status = await personalAny['status'](ctx);
      json(res, 200, status);
      return true;
    }

    // GET /composio/connections
    if (route === '/connections' && req.method === 'GET') {
      const connections = await personalAny['listConnections'](ctx);
      json(res, 200, { connections });
      return true;
    }

    // POST routes need body
    if (req.method !== 'POST') return false;
    const body = await readBody(req);

    // POST /composio/setup — validate + save API key to local-settings.json
    if (route === '/setup') {
      const key = String(body['key'] ?? '').trim();
      if (!key) { json(res, 400, { error: 'Missing key' }); return true; }
      const result = await personalAny.setup(ctx, { key });
      json(res, 200, result);
      return true;
    }

    // POST /composio/connect
    if (route === '/connect') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await personalAny['connectApp'](ctx, { toolkit });
      json(res, 200, result);
      return true;
    }

    // POST /composio/disconnect
    if (route === '/disconnect') {
      const connectedAccountId = String(body['connectedAccountId'] ?? '').trim();
      if (!connectedAccountId) { json(res, 400, { error: 'Missing connectedAccountId' }); return true; }
      await personalAny['disconnectAccount'](ctx, { connectedAccountId });
      json(res, 200, { ok: true });
      return true;
    }

    // POST /composio/wait
    if (route === '/wait') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await personalAny['waitForConnection'](ctx, { toolkit });
      json(res, 200, result);
      return true;
    }
  } catch (err) {
    if (err instanceof CoreError) {
      const e = err as { type?: string; message?: string };
      json(res, 500, { ok: false, error: { type: e.type, message: e.message } });
    } else {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
