import type { RouteContext } from '../../types/server.js';
import { json, readBody } from '../http-utils.js';
import { runPinCli } from '../../pipeline/pin-cli.js';

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

const pushFlag = (args: string[], flag: string, value: unknown): void => {
  const normalized = asTrimmedString(value);
  if (normalized) {
    args.push(flag, normalized);
  }
};

const stringifyMetadata = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return null;
};

export function buildFeedbackLogArgs(body: Record<string, unknown>): string[] {
  const kind = asTrimmedString(body['kind']);
  if (!kind) {
    throw new Error('Missing kind');
  }

  const args = ['feedback', 'log', '--kind', kind];
  pushFlag(args, '--action', body['action']);
  pushFlag(args, '--push-id', body['pushId']);
  pushFlag(args, '--intent-card-id', body['intentCardId']);
  pushFlag(args, '--conversation-id', body['conversationId']);
  pushFlag(args, '--message-id', body['messageId']);
  pushFlag(args, '--source', body['source']);
  if (!args.includes('--source')) {
    args.push('--source', 'user_direct');
  }
  pushFlag(args, '--basket', body['basket']);
  pushFlag(args, '--channel', body['channel']);
  pushFlag(args, '--value', body['value']);
  pushFlag(args, '--text', body['text']);
  pushFlag(args, '--at', body['at']);

  const metadata = stringifyMetadata(body['metadata']);
  if (metadata) {
    args.push('--metadata', metadata);
  }

  return args;
}

export async function handleFeedback(ctx: RouteContext): Promise<boolean> {
  if (ctx.subpath !== '/feedback' || ctx.req.method !== 'POST') return false;

  try {
    const body = await readBody(ctx.req);
    const args = buildFeedbackLogArgs(body);
    const result = await runPinCli(args);
    json(ctx.res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(ctx.res, msg === 'Missing kind' ? 400 : 500, { error: msg });
  }
  return true;
}
