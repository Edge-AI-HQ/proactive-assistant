/**
 * v3 personal_signals HTTP routes:
 *   GET  /signals                 list (defaults: status=open, last 24h, limit 30)
 *                                 ?kind / ?source / ?deviceId / ?since / ?minSalience / ?limit / ?offset
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
        const listOpts: db.ListPersonalSignalsOpts = {
          status: (params.get('status') as db.PersonalSignalStatus | null) ?? 'open',
          kind: params.get('kind') ?? undefined,
          source: params.get('source') ?? undefined,
          deviceId: params.get('deviceId') ?? undefined,
          since: params.get('since') ?? undefined,
          until: params.get('until') ?? undefined,
          minSalience: minSalience !== null ? Number(minSalience) : undefined,
          limit: limit !== null ? Number(limit) : undefined,
          offset: offset !== null ? Number(offset) : undefined,
          pruneExpired: params.get('pruneExpired') === '1',
        };
        const [rows, total] = await Promise.all([
          db.listPersonalSignals(listOpts),
          db.countPersonalSignals(listOpts),
        ]);
        json(ctx.res, 200, { ok: true, signals: rows, total });
        return true;
      }
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }

    return false;
  };
}
