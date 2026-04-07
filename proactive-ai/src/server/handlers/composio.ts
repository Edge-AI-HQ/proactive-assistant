import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';
import {
  connectToolkit,
  getComposioStatus,
  listActiveConnections,
  waitForToolkit,
} from '../composio-platform.js';

export async function handleComposio(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = ctx;
  if (!subpath.startsWith('/composio/')) return false;

  const route = subpath.slice('/composio'.length); // e.g. '/status', '/setup'

  try {
    // GET /composio/status
    if (route === '/status' && req.method === 'GET') {
      json(res, 200, getComposioStatus());
      return true;
    }

    // GET /composio/connections
    if (route === '/connections' && req.method === 'GET') {
      const connections = await listActiveConnections();
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
      const result = await connectToolkit(toolkit);
      json(res, 200, result);
      return true;
    }

    // POST /composio/wait
    if (route === '/wait') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await waitForToolkit(toolkit);
      json(res, 200, result);
      return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
    return true;
  }

  return false;
}
