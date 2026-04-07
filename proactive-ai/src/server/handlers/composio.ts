import { homedir } from 'node:os';
import { personal as corePersonal, CoreError } from '@pin-ai/core';
import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';

const ctx = { env: process.env, homeDir: homedir() };

export async function handleComposio(routeCtx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = routeCtx;
  if (!subpath.startsWith('/composio/')) return false;

  const route = subpath.slice('/composio'.length);

  try {
    // GET /composio/status
    if (route === '/status' && req.method === 'GET') {
      const status = await corePersonal.status(ctx);
      json(res, 200, status);
      return true;
    }

    // GET /composio/connections
    if (route === '/connections' && req.method === 'GET') {
      const connections = await corePersonal.listConnections(ctx);
      json(res, 200, { connections });
      return true;
    }

    // POST routes need body
    if (req.method !== 'POST') return false;
    const body = await readBody(req);

    // POST /composio/setup (deprecated in platform mode)
    if (route === '/setup') {
      json(res, 400, {
        error: 'Setup is not supported in platform mode',
        hint: 'Configure COMPOSIO_API_KEY on host process or local-settings.json',
      });
      return true;
    }

    // POST /composio/connect
    if (route === '/connect') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await corePersonal.connectApp(ctx, { toolkit });
      json(res, 200, result);
      return true;
    }

    // POST /composio/wait
    if (route === '/wait') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await corePersonal.waitForConnection(ctx, { toolkit });
      json(res, 200, result);
      return true;
    }
  } catch (err) {
    if (err instanceof CoreError) {
      json(res, 500, { ok: false, error: { type: err.type, message: err.message } });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: msg });
    }
    return true;
  }

  return false;
}
