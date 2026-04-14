import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

export function handleSettings(): RouteHandler {
  return async (ctx) => {
    if (ctx.subpath === '/settings' && ctx.req.method === 'GET') {
      json(ctx.res, 200, { ok: true, ...(await db.getUserSettings()) });
      return true;
    }
    if (ctx.subpath === '/settings' && ctx.req.method === 'POST') {
      const body = await readBody(ctx.req);
      await db.updateUserSettings({
        generation_language: body['generation_language'] as string | undefined,
        auto_generate: body['auto_generate'] as boolean | undefined,
        auto_dreaming: body['auto_dreaming'] as boolean | undefined,
        metadata: body['metadata'] as Record<string, unknown> | undefined,
      });
      json(ctx.res, 200, { ok: true });
      return true;
    }
    if (ctx.subpath === '/settings/auto-generate') {
      if (ctx.req.method === 'GET') { json(ctx.res, 200, { ok: true, enabled: (await db.getUserSettings()).auto_generate }); return true; }
      if (ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        if (typeof body['enabled'] !== 'boolean') { json(ctx.res, 400, { ok: false, error: 'enabled must be a boolean' }); return true; }
        await db.updateUserSettings({ auto_generate: body['enabled'] as boolean });
        json(ctx.res, 200, { ok: true, enabled: body['enabled'] });
        return true;
      }
    }
    if (ctx.subpath === '/settings/generation-language') {
      if (ctx.req.method === 'GET') {
        const settings = await db.getUserSettings();
        json(ctx.res, 200, { ok: true, language: settings.generation_language, defaultLanguage: 'en',
          options: [{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }, { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' }, { value: 'es', label: 'Español' }],
        });
        return true;
      }
      if (ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        if (!body['language']) { json(ctx.res, 400, { ok: false, error: 'Missing language' }); return true; }
        await db.updateUserSettings({ generation_language: body['language'] as string });
        json(ctx.res, 200, { ok: true, language: body['language'] });
        return true;
      }
    }
    if (ctx.subpath === '/settings/auto-dreaming') {
      if (ctx.req.method === 'GET') { json(ctx.res, 200, { ok: true, enabled: (await db.getUserSettings()).auto_dreaming, schedule: null }); return true; }
      if (ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        if (typeof body['enabled'] !== 'boolean') { json(ctx.res, 400, { ok: false, error: 'enabled must be a boolean' }); return true; }
        await db.updateUserSettings({ auto_dreaming: body['enabled'] as boolean });
        json(ctx.res, 200, { ok: true, enabled: body['enabled'], schedule: null });
        return true;
      }
    }
    return false;
  };
}
