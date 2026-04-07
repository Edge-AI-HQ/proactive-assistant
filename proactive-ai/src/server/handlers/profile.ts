import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';
import { pinCli } from '../../pipeline/pin-cli.js';

export async function handleProfile(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = ctx;
  if (!subpath.startsWith('/profile/')) return false;

  const route = subpath.slice('/profile'.length); // e.g. '/goals', '/goals/close'

  try {
    // GET /profile/goals
    if (route === '/goals' && req.method === 'GET') {
      const result = await pinCli('profile goals list');
      json(res, 200, { ok: true, goals: result.ok ? result.data : [] });
      return true;
    }

    // POST /profile/goals
    if (route === '/goals' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body['key'] ?? '').trim();
      const title = String(body['title'] ?? '').trim();
      const priority = String(body['priority'] ?? 'medium').trim();
      if (!key || !title) { json(res, 400, { error: 'Missing key or title' }); return true; }
      const result = await pinCli(`profile goals upsert --key ${key} --title "${title}" --priority ${priority}`);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
      return true;
    }

    // POST /profile/goals/close
    if (route === '/goals/close' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body['key'] ?? '').trim();
      if (!key) { json(res, 400, { error: 'Missing key' }); return true; }
      const result = await pinCli(`profile goals close --key ${key}`);
      json(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
      return true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
    return true;
  }

  return false;
}
