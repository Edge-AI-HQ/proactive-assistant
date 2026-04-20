/**
 * /skills — CRUD for user_skills rows produced by the conversation
 * crystallize pipeline (or manually authored).
 *
 *   GET    /skills                 → list (optional ?status=active|disabled)
 *   GET    /skills/:id             → detail
 *   PATCH  /skills/:id             → partial update (title / body_md / triggers / status / source_summary)
 *   DELETE /skills/:id             → hard delete
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

type SkillPatch = Partial<{
  title: string;
  body_md: string;
  triggers: string[];
  status: 'active' | 'disabled';
  source_summary: string | null;
}>;

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_TRIGGERS = 16;
const MAX_TRIGGER_LEN = 200;
const MAX_SOURCE_SUMMARY = 2_000;

export function handleSkills(): RouteHandler {
  return async (ctx) => {
    // GET /skills
    if (ctx.subpath === '/skills' && ctx.req.method === 'GET') {
      const statusParam = ctx.url.searchParams.get('status');
      const status = statusParam === 'active' || statusParam === 'disabled' ? statusParam : undefined;
      const limitParam = Number.parseInt(ctx.url.searchParams.get('limit') ?? '', 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined;
      const skills = await db.listUserSkills({ status, limit });
      json(ctx.res, 200, { ok: true, skills });
      return true;
    }

    // GET /skills/:id
    const getMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (getMatch && ctx.req.method === 'GET') {
      const skill = await db.getUserSkill(getMatch[1]!);
      if (!skill) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      json(ctx.res, 200, { ok: true, skill });
      return true;
    }

    // PATCH /skills/:id
    const patchMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (patchMatch && ctx.req.method === 'PATCH') {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(ctx.req)) as Record<string, unknown>;
      } catch {
        json(ctx.res, 400, { ok: false, error: 'Invalid JSON body' });
        return true;
      }
      const patch = normalizePatch(body);
      if ('error' in patch) {
        json(ctx.res, 400, { ok: false, error: patch.error });
        return true;
      }
      const updated = await db.updateUserSkill(patchMatch[1]!, patch);
      if (!updated) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      json(ctx.res, 200, { ok: true, skill: updated });
      return true;
    }

    // DELETE /skills/:id
    const delMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (delMatch && ctx.req.method === 'DELETE') {
      const removed = await db.deleteUserSkill(delMatch[1]!);
      if (!removed) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      json(ctx.res, 200, { ok: true, deleted: true });
      return true;
    }

    return false;
  };
}

function normalizePatch(raw: Record<string, unknown>): SkillPatch | { error: string } {
  const patch: SkillPatch = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) return { error: 'title must be a non-empty string' };
    if (raw.title.length > MAX_TITLE) return { error: `title exceeds ${MAX_TITLE} chars` };
    patch.title = raw.title.trim();
  }

  if (raw.body_md !== undefined) {
    if (typeof raw.body_md !== 'string' || !raw.body_md.trim()) return { error: 'body_md must be a non-empty string' };
    if (raw.body_md.length > MAX_BODY) return { error: `body_md exceeds ${MAX_BODY} chars` };
    patch.body_md = raw.body_md;
  }

  if (raw.triggers !== undefined) {
    if (!Array.isArray(raw.triggers)) return { error: 'triggers must be an array of strings' };
    if (raw.triggers.length > MAX_TRIGGERS) return { error: `triggers exceeds ${MAX_TRIGGERS} items` };
    const triggers: string[] = [];
    for (const t of raw.triggers) {
      if (typeof t !== 'string') return { error: 'each trigger must be a string' };
      const trimmed = t.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_TRIGGER_LEN) return { error: `trigger exceeds ${MAX_TRIGGER_LEN} chars` };
      triggers.push(trimmed);
    }
    patch.triggers = triggers;
  }

  if (raw.status !== undefined) {
    if (raw.status !== 'active' && raw.status !== 'disabled') {
      return { error: 'status must be "active" or "disabled"' };
    }
    patch.status = raw.status;
  }

  if (raw.source_summary !== undefined) {
    if (raw.source_summary === null) {
      patch.source_summary = null;
    } else if (typeof raw.source_summary === 'string') {
      if (raw.source_summary.length > MAX_SOURCE_SUMMARY) return { error: `source_summary exceeds ${MAX_SOURCE_SUMMARY} chars` };
      patch.source_summary = raw.source_summary;
    } else {
      return { error: 'source_summary must be a string or null' };
    }
  }

  return patch;
}
