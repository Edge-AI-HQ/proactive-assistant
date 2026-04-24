/**
 * /skills — CRUD for v3 skill_index rows (body lives in
 * ${OPENCLAW_HOME}/data/skills/<id>/SKILL.md).
 *
 *   GET    /skills                 list, optional ?status=enabled|disabled|archived
 *   GET    /skills/:id             detail (includes `body`)
 *   POST   /skills                 manual create (source='manual')
 *   PATCH  /skills/:id             partial update (title / description /
 *                                   body / triggers / status). status transitions
 *                                   route through enable / disable / archive
 *                                   helpers to keep the audit timestamps honest.
 *   DELETE /skills/:id             soft-delete: flips status to 'archived'
 *                                   (kept reversible; no hard delete).
 *
 * Response shape is the v3 native `SkillIndexRow` plus an optional `body`
 * field on detail responses. See docs/plans/memory-architecture.mdx §三 (skill_index).
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2_000;
const MAX_BODY = 20_000;
const MAX_TRIGGERS = 16;
const MAX_TRIGGER_LEN = 200;

type SkillCreateInput = {
  id?: string;
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  status?: db.SkillStatus;
};

type SkillPatch = {
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  status?: db.SkillStatus;
};

export function handleSkills(): RouteHandler {
  return async (ctx) => {
    // GET /skills
    if (ctx.subpath === '/skills' && ctx.req.method === 'GET') {
      const statusParam = ctx.url.searchParams.get('status');
      const status = statusParam === 'enabled' || statusParam === 'disabled' || statusParam === 'archived'
        ? (statusParam as db.SkillStatus)
        : undefined;
      const limitParam = Number.parseInt(ctx.url.searchParams.get('limit') ?? '', 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined;
      const skills = await db.listSkills({ status, limit });
      json(ctx.res, 200, { ok: true, skills });
      return true;
    }

    // POST /skills (manual create)
    if (ctx.subpath === '/skills' && ctx.req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = (await readBody(ctx.req)) as Record<string, unknown>;
      } catch {
        json(ctx.res, 400, { ok: false, error: 'Invalid JSON body' });
        return true;
      }
      const input = normalizeCreate(body);
      if ('error' in input) {
        json(ctx.res, 400, { ok: false, error: input.error });
        return true;
      }
      const id = input.id && input.id.trim() ? input.id.trim() : genSkillId();
      const created = await db.addSkill({
        id,
        title: input.title,
        body: input.body,
        description: input.description ?? null,
        triggers: input.triggers ?? [],
        source: 'manual',
        status: input.status ?? 'enabled',
      });
      json(ctx.res, 200, { ok: true, skill: { ...created, body: input.body } });
      return true;
    }

    // GET /skills/:id
    const getMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (getMatch && ctx.req.method === 'GET') {
      const skill = await db.getSkillIndex(getMatch[1]!);
      if (!skill) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      const bodyMd = db.readSkillBody(skill.id) ?? '';
      json(ctx.res, 200, { ok: true, skill: { ...skill, body: bodyMd } });
      return true;
    }

    // PATCH /skills/:id
    const patchMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (patchMatch && ctx.req.method === 'PATCH') {
      const id = patchMatch[1]!;
      const existing = await db.getSkillIndex(id);
      if (!existing) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }

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

      // Status transition uses the dedicated helpers so enabled_at / disabled_at
      // stay in sync with the last action.
      if (patch.status !== undefined && patch.status !== existing.status) {
        if (patch.status === 'enabled') await db.enableSkill(id);
        else if (patch.status === 'disabled') await db.disableSkill(id);
        else if (patch.status === 'archived') await db.archiveSkill(id);
      }

      // Only call updateSkill if there is at least one content-bearing field.
      const hasContentChange =
        patch.title !== undefined
        || patch.description !== undefined
        || patch.body !== undefined
        || patch.triggers !== undefined;
      if (hasContentChange) {
        await db.updateSkill({
          id,
          title: patch.title,
          description: patch.description,
          body: patch.body,
          triggers: patch.triggers,
        });
      }

      const updated = await db.getSkillIndex(id);
      if (!updated) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      const bodyMd = db.readSkillBody(id) ?? '';
      json(ctx.res, 200, { ok: true, skill: { ...updated, body: bodyMd } });
      return true;
    }

    // DELETE /skills/:id → archive (soft-delete)
    const delMatch = ctx.subpath.match(/^\/skills\/([^/]+)$/);
    if (delMatch && ctx.req.method === 'DELETE') {
      const archived = await db.archiveSkill(delMatch[1]!);
      if (!archived) { json(ctx.res, 404, { ok: false, error: 'Skill not found' }); return true; }
      json(ctx.res, 200, { ok: true, skill: archived });
      return true;
    }

    return false;
  };
}

function genSkillId(): string {
  // Short human-readable-ish id for manually authored skills. 12 hex chars
  // matches the style of existing v3 skill ids (evolution agent uses ULIDs,
  // but those are opaque — manual skills can stay shorter).
  return `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCreate(raw: Record<string, unknown>): SkillCreateInput | { error: string } {
  if (typeof raw.title !== 'string' || !raw.title.trim()) return { error: 'title must be a non-empty string' };
  if (raw.title.length > MAX_TITLE) return { error: `title exceeds ${MAX_TITLE} chars` };

  if (typeof raw.body !== 'string' || !raw.body.trim()) return { error: 'body must be a non-empty string' };
  if (raw.body.length > MAX_BODY) return { error: `body exceeds ${MAX_BODY} chars` };

  const created: SkillCreateInput = {
    title: raw.title.trim(),
    body: raw.body,
  };

  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || !raw.id.trim()) return { error: 'id must be a non-empty string' };
    created.id = raw.id;
  }

  if (raw.description !== undefined) {
    if (raw.description === null) {
      created.description = null;
    } else if (typeof raw.description === 'string') {
      if (raw.description.length > MAX_DESCRIPTION) return { error: `description exceeds ${MAX_DESCRIPTION} chars` };
      created.description = raw.description;
    } else {
      return { error: 'description must be a string or null' };
    }
  }

  if (raw.triggers !== undefined) {
    const triggers = normalizeTriggers(raw.triggers);
    if (!Array.isArray(triggers)) return triggers;
    created.triggers = triggers;
  }

  if (raw.status !== undefined) {
    if (raw.status !== 'enabled' && raw.status !== 'disabled') {
      return { error: 'status on create must be "enabled" or "disabled"' };
    }
    created.status = raw.status;
  }

  return created;
}

function normalizePatch(raw: Record<string, unknown>): SkillPatch | { error: string } {
  const patch: SkillPatch = {};

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string' || !raw.title.trim()) return { error: 'title must be a non-empty string' };
    if (raw.title.length > MAX_TITLE) return { error: `title exceeds ${MAX_TITLE} chars` };
    patch.title = raw.title.trim();
  }

  if (raw.description !== undefined) {
    if (raw.description === null) {
      patch.description = null;
    } else if (typeof raw.description === 'string') {
      if (raw.description.length > MAX_DESCRIPTION) return { error: `description exceeds ${MAX_DESCRIPTION} chars` };
      patch.description = raw.description;
    } else {
      return { error: 'description must be a string or null' };
    }
  }

  if (raw.body !== undefined) {
    if (typeof raw.body !== 'string' || !raw.body.trim()) return { error: 'body must be a non-empty string' };
    if (raw.body.length > MAX_BODY) return { error: `body exceeds ${MAX_BODY} chars` };
    patch.body = raw.body;
  }

  if (raw.triggers !== undefined) {
    const triggers = normalizeTriggers(raw.triggers);
    if (!Array.isArray(triggers)) return triggers;
    patch.triggers = triggers;
  }

  if (raw.status !== undefined) {
    if (raw.status !== 'enabled' && raw.status !== 'disabled' && raw.status !== 'archived') {
      return { error: 'status must be "enabled", "disabled", or "archived"' };
    }
    patch.status = raw.status;
  }

  return patch;
}

function normalizeTriggers(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'triggers must be an array of strings' };
  if (raw.length > MAX_TRIGGERS) return { error: `triggers exceeds ${MAX_TRIGGERS} items` };
  const triggers: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') return { error: 'each trigger must be a string' };
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TRIGGER_LEN) return { error: `trigger exceeds ${MAX_TRIGGER_LEN} chars` };
    triggers.push(trimmed);
  }
  return triggers;
}
