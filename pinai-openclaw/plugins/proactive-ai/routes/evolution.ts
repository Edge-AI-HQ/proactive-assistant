/**
 * v3 evolution_runs HTTP routes (read + write).
 *
 *   GET  /evolution                  ?triggerKind / ?status / ?since / ?limit
 *   GET  /evolution/<id>             single row
 *   POST /evolution                  create new run (body: triggerKind, etc.)
 *   POST /evolution/<id>/delta       record memory/skill/profile counters
 *   POST /evolution/<id>/refs/consumed   body: { table, ids }
 *   POST /evolution/<id>/refs/produced   body: { table, ids }
 *   POST /evolution/<id>/complete    body: { llmTokens?, durationMs? }
 *   POST /evolution/<id>/fail        body: { error }
 *
 * See docs/memory-architecture.md §三 (evolution_runs).
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

export function handleEvolution(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/evolution')) return false;
    const route = ctx.subpath.slice('/evolution'.length) || '/';

    try {
      if (route === '/' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const triggerKind = String(body['triggerKind'] ?? '').trim() as db.EvolutionTrigger;
        if (!triggerKind) { json(ctx.res, 400, { error: 'Missing triggerKind' }); return true; }
        const row = await db.createEvolutionRun({
          triggerKind,
          windowStart: typeof body['windowStart'] === 'string' ? body['windowStart'] : null,
          windowEnd: typeof body['windowEnd'] === 'string' ? body['windowEnd'] : null,
          contextSummary: typeof body['contextSummary'] === 'string' ? body['contextSummary'] : null,
          promptExcerpt: typeof body['promptExcerpt'] === 'string' ? body['promptExcerpt'] : null,
        });
        json(ctx.res, 200, { ok: true, run: row });
        return true;
      }

      const m = route.match(/^\/([^/]+)(\/.*)?$/);
      if (m) {
        const id = m[1]!;
        const sub = m[2] ?? '';

        if (sub === '/delta' && ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          await db.recordEvolutionDelta(id, {
            memoriesWritten: typeof body['memoriesWritten'] === 'number' ? body['memoriesWritten'] : undefined,
            memoriesArchived: typeof body['memoriesArchived'] === 'number' ? body['memoriesArchived'] : undefined,
            memoriesSuperseded: typeof body['memoriesSuperseded'] === 'number' ? body['memoriesSuperseded'] : undefined,
            profileUpdated: typeof body['profileUpdated'] === 'boolean' ? body['profileUpdated'] : undefined,
            profileChangedKeys: Array.isArray(body['profileChangedKeys'])
              ? body['profileChangedKeys'].filter((k): k is string => typeof k === 'string') : undefined,
            skillsAdded: typeof body['skillsAdded'] === 'number' ? body['skillsAdded'] : undefined,
            skillsUpdated: typeof body['skillsUpdated'] === 'number' ? body['skillsUpdated'] : undefined,
            skillsDisabled: typeof body['skillsDisabled'] === 'number' ? body['skillsDisabled'] : undefined,
            signalsConsumed: typeof body['signalsConsumed'] === 'number' ? body['signalsConsumed'] : undefined,
          });
          json(ctx.res, 200, { ok: true });
          return true;
        }

        if (sub === '/refs/consumed' && ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const table = String(body['table'] ?? '').trim();
          const ids = Array.isArray(body['ids']) ? body['ids'].filter((i): i is string => typeof i === 'string') : [];
          await db.recordEvolutionRefsConsumed(id, table, ids);
          json(ctx.res, 200, { ok: true });
          return true;
        }

        if (sub === '/refs/produced' && ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const table = String(body['table'] ?? '').trim();
          const ids = Array.isArray(body['ids']) ? body['ids'].filter((i): i is string => typeof i === 'string') : [];
          await db.recordEvolutionRefsProduced(id, table, ids);
          json(ctx.res, 200, { ok: true });
          return true;
        }

        if (sub === '/complete' && ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const row = await db.completeEvolutionRun(id, {
            llmTokens: typeof body['llmTokens'] === 'number' ? body['llmTokens'] : undefined,
            durationMs: typeof body['durationMs'] === 'number' ? body['durationMs'] : undefined,
          });
          json(ctx.res, 200, { ok: true, run: row });
          return true;
        }

        if (sub === '/fail' && ctx.req.method === 'POST') {
          const body = await readBody(ctx.req);
          const errorMessage = String(body['error'] ?? 'unknown').trim();
          const row = await db.failEvolutionRun(id, errorMessage);
          json(ctx.res, 200, { ok: true, run: row });
          return true;
        }

        if (!sub && ctx.req.method === 'GET') {
          const row = await db.getEvolutionRun(id);
          if (!row) { json(ctx.res, 404, { error: 'Not found' }); return true; }
          json(ctx.res, 200, { ok: true, run: row });
          return true;
        }
      }

      if (route === '/' && ctx.req.method === 'GET') {
        const p = ctx.url.searchParams;
        const limit = p.get('limit');
        const rows = await db.listEvolutionRuns({
          triggerKind: (p.get('triggerKind') as db.EvolutionTrigger | null) ?? undefined,
          status: (p.get('status') as db.EvolutionRunStatus | null) ?? undefined,
          since: p.get('since') ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        });
        json(ctx.res, 200, { ok: true, runs: rows });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}
