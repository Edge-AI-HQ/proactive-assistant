/**
 * v3 personal_signals HTTP routes:
 *   GET  /signals                 list (defaults: status=open, last 24h, limit 30)
 *                                 ?kind / ?source / ?deviceId / ?since / ?minSalience
 *                                 ?limit / ?offset / ?before=<occurred_at>__<id>
 *                                 ?status=all  bypasses the status filter (timeline view)
 *                                 prefer ?before over ?offset for large feeds
 *   POST /signals/ingest          add personal_signals (server-side or future device direct upload)
 *   POST /signals/<id>/consume    mark as consumed (with body { runId })
 *
 * See docs/plans/memory-architecture.mdx §三 (personal_signals).
 */
import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

export function handleSignals(): RouteHandler {
  return async (ctx) => {
    if (!ctx.subpath.startsWith('/signals')) return false;
    const route = ctx.subpath.slice('/signals'.length) || '/';

    try {
      // POST /signals/ingest
      if (route === '/ingest' && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const items = Array.isArray(body['items']) ? body['items'] : [];
        const inputs: db.IngestPersonalSignalInput[] = items
          .filter((i: unknown): i is Record<string, unknown> => !!i && typeof i === 'object')
          .map((i: Record<string, unknown>) => ({
            id: typeof i['id'] === 'string' ? i['id'] : undefined,
            kind: typeof i['kind'] === 'string' ? i['kind'] : '',
            title: typeof i['title'] === 'string' ? i['title'] : '',
            summary: typeof i['summary'] === 'string' ? i['summary'] : '',
            payload: i['payload'] && typeof i['payload'] === 'object' ? i['payload'] as Record<string, unknown> : {},
            salience: typeof i['salience'] === 'number' ? i['salience'] : 0,
            confidence: typeof i['confidence'] === 'number' ? i['confidence'] : 0,
            dedupeKey: typeof i['dedupeKey'] === 'string' ? i['dedupeKey'] : null,
            occurredAt: typeof i['occurredAt'] === 'string' ? i['occurredAt'] : undefined,
            availableAt: typeof i['availableAt'] === 'string' ? i['availableAt'] : undefined,
            expiresAt: typeof i['expiresAt'] === 'string' ? i['expiresAt'] : null,
            source: typeof i['source'] === 'string' ? i['source'] : 'device',
            deviceId: typeof i['deviceId'] === 'string' ? i['deviceId'] : null,
            subject: typeof i['subject'] === 'string' ? i['subject'] : null,
            sourceRawTable: typeof i['sourceRawTable'] === 'string' ? i['sourceRawTable'] : null,
            sourceRawIds: Array.isArray(i['sourceRawIds'])
              ? i['sourceRawIds'].filter((s): s is string => typeof s === 'string') : [],
          }));
        const result = await db.ingestPersonalSignals(inputs);
        json(ctx.res, 200, { ok: true, ...result });
        return true;
      }

      // POST /signals/<id>/consume
      const consumeMatch = route.match(/^\/([^/]+)\/consume$/);
      if (consumeMatch && ctx.req.method === 'POST') {
        const body = await readBody(ctx.req);
        const runId = String(body['runId'] ?? '').trim();
        if (!runId) { json(ctx.res, 400, { error: 'Missing runId' }); return true; }
        const updated = await db.markPersonalSignalsConsumed([consumeMatch[1]!], runId);
        json(ctx.res, 200, { ok: true, updated });
        return true;
      }

      // GET /signals
      if (route === '/' && ctx.req.method === 'GET') {
        const params = ctx.url.searchParams;
        const minSalience = params.get('minSalience');
        const limit = params.get('limit');
        const offset = params.get('offset');
        // status='all' (or unset when deviceId/kind is given) returns rows
        // regardless of consumed/archived/open. Timeline views need this.
        const rawStatus = params.get('status');
        const statusOpt: db.PersonalSignalStatus | undefined =
          rawStatus === 'all' ? undefined
            : rawStatus !== null ? (rawStatus as db.PersonalSignalStatus)
              : 'open';
        const before = parseCursor(params.get('before'));
        const listOpts: db.ListPersonalSignalsOpts = {
          status: statusOpt,
          kind: params.get('kind') ?? undefined,
          source: params.get('source') ?? undefined,
          deviceId: params.get('deviceId') ?? undefined,
          since: params.get('since') ?? undefined,
          until: params.get('until') ?? undefined,
          minSalience: minSalience !== null ? Number(minSalience) : undefined,
          limit: limit !== null ? Number(limit) : undefined,
          offset: offset !== null ? Number(offset) : undefined,
          before: before ?? undefined,
          pruneExpired: params.get('pruneExpired') === '1',
        };
        // Fetch one extra row to know whether more exists. Cheaper than a
        // separate COUNT(*) on every page.
        const fetchLimit = Math.max(1, Math.min(listOpts.limit ?? 50, 500));
        const [rows, total] = await Promise.all([
          db.listPersonalSignals({ ...listOpts, limit: fetchLimit + 1 }),
          // Skip total when paginating with cursor — it's expensive on big
          // tables and the client doesn't need it page-by-page.
          before ? Promise.resolve(-1) : db.countPersonalSignals(listOpts),
        ]);
        const hasMore = rows.length > fetchLimit;
        const trimmed = hasMore ? rows.slice(0, fetchLimit) : rows;
        const last = trimmed[trimmed.length - 1];
        const nextCursor = hasMore && last ? buildCursor(last.occurred_at, last.id) : null;
        json(ctx.res, 200, {
          ok: true,
          signals: trimmed,
          total,
          next_cursor: nextCursor,
          has_more: hasMore,
        });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}

// Cursor format: `<occurred_at>__<id>`. Both halves are URL-safe ASCII
// (ISO 8601 timestamp + ULID/UUID-ish id), so no encoding gymnastics
// needed. Returning the same string the client received tomorrow keeps
// pagination stable across schema noise.
function buildCursor(occurredAt: string, id: string): string {
  return `${occurredAt}__${id}`;
}

function parseCursor(raw: string | null): { occurredAt: string; id: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf('__');
  if (idx <= 0 || idx === raw.length - 2) return null;
  const occurredAt = raw.slice(0, idx);
  const id = raw.slice(idx + 2);
  if (!occurredAt || !id) return null;
  return { occurredAt, id };
}
