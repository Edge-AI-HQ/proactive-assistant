import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';
import { pinCli } from '../../pipeline/pin-cli.js';

export async function handleComposio(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = ctx;
  if (!subpath.startsWith('/composio/')) return false;

  const route = subpath.slice('/composio'.length); // e.g. '/status', '/setup'

  try {
    // GET /composio/status
    if (route === '/status' && req.method === 'GET') {
      const result = await pinCli('personal status');
      json(res, 200, result.ok ? result.data : { configured: false });
      return true;
    }

    // GET /composio/connections
    if (route === '/connections' && req.method === 'GET') {
      const result = await pinCli('personal connections list');
      json(res, 200, { connections: result.ok && Array.isArray(result.data) ? result.data : [] });
      return true;
    }

    // POST routes need body
    if (req.method !== 'POST') return false;
    const body = await readBody(req);

    // POST /composio/setup
    if (route === '/setup') {
      const key = String(body['key'] ?? '').trim();
      if (!key) { json(res, 400, { error: 'Missing key' }); return true; }
      const result = await pinCli(`personal setup --key ${key}`);
      json(res, result.ok ? 200 : 400, result.ok ? result.data : { error: result.error ?? 'Setup failed' });
      return true;
    }

    // POST /composio/connect
    if (route === '/connect') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await pinCli(`personal connect --toolkit ${toolkit}`);
      json(res, result.ok ? 200 : 400, result.ok ? result.data : { error: result.error ?? 'Connect failed' });
      return true;
    }

    // POST /composio/wait
    if (route === '/wait') {
      const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
      if (!toolkit) { json(res, 400, { error: 'Missing toolkit' }); return true; }
      const result = await pinCli(`personal wait --toolkit ${toolkit}`);
      json(res, result.ok ? 200 : 400, result.ok ? result.data : { error: result.error ?? 'Wait failed' });
      return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
    return true;
  }

  return false;
}
