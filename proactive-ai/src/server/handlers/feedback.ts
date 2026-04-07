import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';
import { pinCli } from '../../pipeline/pin-cli.js';

export async function handleFeedback(ctx: RouteContext): Promise<boolean> {
  if (ctx.subpath !== '/feedback' || ctx.req.method !== 'POST') return false;

  try {
    const body = await readBody(ctx.req);
    const kind = String(body['kind'] ?? '').trim();
    if (!kind) {
      json(ctx.res, 400, { error: 'Missing kind' });
      return true;
    }

    const parts = ['feedback log', `--kind ${kind}`];
    if (body['action'])       parts.push(`--action ${body['action']}`);
    if (body['intentCardId']) parts.push(`--intent-card-id ${body['intentCardId']}`);
    if (body['basket'])       parts.push(`--basket ${body['basket']}`);
    if (body['source'])       parts.push(`--source ${body['source']}`);
    else                      parts.push('--source user_direct');

    const result = await pinCli(parts.join(' '));
    json(ctx.res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(ctx.res, 500, { error: msg });
  }
  return true;
}
