/**
 * v3 memory HTTP routes:
 *   GET  /memory                  list active, optional ?minQuality / ?subject /
 *                                 ?subjectPrefix / ?since / ?limit / ?orderBy
 *   GET  /memory/<id>             single row
 *   POST /memory                  add a new memory (body: AddMemoryV3Input)
 *   POST /memory/<id>/archive     status='active' → 'archived'
 *   POST /memory/supersede        body: { oldId, newId }
 *
 * See docs/memory-architecture.md §六 (CLI / agent interface).
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

export function handleMemory(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/memory')) return false;
    const route = ctx.subpath.slice('/memory'.length) || '/';

    try {
      // POST /memory  → add
      if (route === '/' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const text = String(body['text'] ?? '').trim();
        const source = String(body['source'] ?? '').trim();
        if (!text) { json(ctx.res, 400, { error: 'Missing text' }); return true; }
        if (!source) { json(ctx.res, 400, { error: 'Missing source' }); return true; }
        const row = await db.addMemoryV3({
          text,
          source,
          subject: typeof body['subject'] === 'string' ? body['subject'] : null,
          quality: typeof body['quality'] === 'number' ? body['quality'] : undefined,
          confidence: typeof body['confidence'] === 'number' ? body['confidence'] : undefined,
          occurredAt: typeof body['occurredAt'] === 'string' ? body['occurredAt'] : null,
          tags: Array.isArray(body['tags']) ? body['tags'].filter((t): t is string => typeof t === 'string') : [],
          sourceRunId: typeof body['sourceRunId'] === 'string' ? body['sourceRunId'] : null,
        });
        json(ctx.res, 200, { ok: true, memory: row });
        return true;
      }

      // POST /memory/supersede
      if (route === '/supersede' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const oldId = String(body['oldId'] ?? '').trim();
        const newId = String(body['newId'] ?? '').trim();
        if (!oldId || !newId) { json(ctx.res, 400, { error: 'Missing oldId / newId' }); return true; }
        await db.supersedeMemoryV3(oldId, newId);
        json(ctx.res, 200, { ok: true });
        return true;
      }

      // POST /memory/<id>/archive
      const archiveMatch = route.match(/^\/([^/]+)\/archive$/);
      if (archiveMatch && ctx.req.method === 'POST') {
        await db.archiveMemoryV3(archiveMatch[1]!);
        json(ctx.res, 200, { ok: true });
        return true;
      }

      // GET /memory/<id>
      const idMatch = route.match(/^\/([^/]+)$/);
      if (idMatch && ctx.req.method === 'GET') {
        const row = await db.getMemoryV3(idMatch[1]!);
        if (!row) { json(ctx.res, 404, { error: 'Not found' }); return true; }
        json(ctx.res, 200, { ok: true, memory: row });
        return true;
      }

      // GET /memory  → list
      if (route === '/' && ctx.req.method === 'GET') {
        const params = ctx.url.searchParams;
        const minQuality = params.get('minQuality');
        const limit = params.get('limit');
        const rows = await db.listMemoryV3({
          status: (params.get('status') as db.MemoryStatus | null) ?? 'active',
          minQuality: minQuality !== null ? Number(minQuality) : undefined,
          source: params.get('source') ?? undefined,
          subject: params.get('subject') ?? undefined,
          subjectPrefix: params.get('subjectPrefix') ?? undefined,
          since: params.get('since') ?? undefined,
          until: params.get('until') ?? undefined,
          orderBy: (params.get('orderBy') as 'created_at' | 'quality' | 'last_referenced_at' | null) ?? undefined,
          orderDirection: (params.get('orderDirection') as 'asc' | 'desc' | null) ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
        });
        json(ctx.res, 200, { ok: true, memories: rows });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}
