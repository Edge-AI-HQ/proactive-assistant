import { homedir } from 'node:os';
import { profile as coreProfile, CoreError } from '@pin-ai/core';
import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';

const ctx = { env: process.env, homeDir: homedir() };

function coreErrorToHttp(res: import('node:http').ServerResponse, err: unknown): void {
  if (err instanceof CoreError) {
    const status = err.type === 'not_found' ? 404
                 : err.type === 'validation' ? 400
                 : err.type === 'conflict' ? 409
                 : 500;
    json(res, status, { ok: false, error: { type: err.type, code: err.code, message: err.message, hint: err.hint } });
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
}

export async function handleProfile(routeCtx: RouteContext): Promise<boolean> {
  const { subpath, req, res } = routeCtx;
  if (!subpath.startsWith('/profile/')) return false;

  const route = subpath.slice('/profile'.length);

  try {
    // GET /profile/goals
    if (route === '/goals' && req.method === 'GET') {
      const goals = await coreProfile.listGoals(ctx);
      json(res, 200, { ok: true, goals });
      return true;
    }

    // POST /profile/goals
    if (route === '/goals' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body['key'] ?? '').trim();
      const title = String(body['title'] ?? '').trim();
      const priority = String(body['priority'] ?? 'medium').trim();
      if (!key || !title) { json(res, 400, { error: 'Missing key or title' }); return true; }
      const goals = await coreProfile.upsertGoal(ctx, { key, title, priority });
      json(res, 200, { ok: true, data: goals });
      return true;
    }

    // POST /profile/goals/close
    if (route === '/goals/close' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body['key'] ?? '').trim();
      if (!key) { json(res, 400, { error: 'Missing key' }); return true; }
      const goals = await coreProfile.closeGoal(ctx, key);
      json(res, 200, { ok: true, data: goals });
      return true;
    }
  } catch (err) {
    coreErrorToHttp(res, err);
    return true;
  }

  return false;
}
