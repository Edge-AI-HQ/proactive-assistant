import type { RouteHandler } from './types.js';
import { json, readBody } from './types.js';
import * as db from '../db.js';

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
};

function normalizeMetadata(
  value: unknown,
): string | Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function handleFeedback(): RouteHandler {
  return async (ctx) => {
    // GET /feedback/dismissed — list dismissed card IDs
    if (ctx.subpath === '/feedback/dismissed' && ctx.req.method === 'GET') {
      try {
        const records = await db.listFeedback({ kind: 'dismiss', limit: 200 });
        const ids = [...new Set(
          records
            .map((r) => (r as Record<string, unknown>).intent_card_id as string | undefined)
            .filter((id): id is string => !!id),
        )];
        json(ctx.res, 200, { ok: true, dismissedCardIds: ids });
      } catch (err) {
        json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    if (ctx.subpath !== '/feedback' || ctx.req.method !== 'POST') return false;
    try {
      const body = await readBody(ctx.req);
      const kind = asTrimmedString(body['kind']) ?? '';
      if (!kind) { json(ctx.res, 400, { error: 'Missing kind' }); return true; }
      const metadata = normalizeMetadata(body['metadata']);
      const record = await db.logFeedback({
        kind,
        action: asTrimmedString(body['action']) ?? undefined,
        pushId: asTrimmedString(body['pushId']) ?? undefined,
        intentCardId: asTrimmedString(body['intentCardId']) ?? undefined,
        conversationId: asTrimmedString(body['conversationId']) ?? undefined,
        messageId: asTrimmedString(body['messageId']) ?? undefined,
        source: asTrimmedString(body['source']) ?? 'user_direct',
        basket: asTrimmedString(body['basket']) ?? undefined,
        channel: asTrimmedString(body['channel']) ?? undefined,
        value: asTrimmedString(body['value']) ?? undefined,
        text: asTrimmedString(body['text']) ?? undefined,
        metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
        at: asTrimmedString(body['at']) ?? undefined,
      });
      json(ctx.res, 200, { ok: true, data: record });
    } catch (err) {
      json(ctx.res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
