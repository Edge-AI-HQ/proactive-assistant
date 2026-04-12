import { parseArgs, success, failure } from './shared.js';
import * as db from '../db.js';

export async function handlePush(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (sub === 'record') {
    if (!flags['kind'] || !flags['title']) return failure('push', 'record', 'validation', 'Missing --kind or --title');
    const record = await db.recordPush({
      kind: flags['kind'],
      title: flags['title'],
      intentCardId: flags['intent-card-id'],
      basket: flags['basket'],
      channel: flags['channel'],
      ref: flags['ref'],
      reason: flags['reason'],
      metadata: flags['metadata'] ? JSON.parse(flags['metadata']) : undefined,
    });
    return success('push', 'record', record);
  }

  if (sub === 'history') {
    const records = await db.pushHistory({
      kind: flags['kind'],
      basket: flags['basket'],
      since: flags['since'],
      limit: flags['limit'] ? parseInt(flags['limit'], 10) : undefined,
    });
    return success('push', 'history', { count: records.length, records });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('push', 'get', 'validation', 'Missing --id');
    const result = await db.getPush(flags['id']);
    if (!result) return failure('push', 'get', 'not_found', `Push record ${flags['id']} not found`);
    return success('push', 'get', result);
  }

  if (sub === 'outcome') {
    if (!flags['id'] || !flags['status']) return failure('push', 'outcome', 'validation', 'Missing --id or --status');
    const outcome = await db.recordOutcome(flags['id'], flags['status']);
    return success('push', 'outcome', outcome);
  }

  if (sub === 'find-similar') {
    if (!flags['kind']) return failure('push', 'find-similar', 'validation', 'Missing --kind');
    const records = await db.findSimilarPushes({
      kind: flags['kind'],
      ref: flags['ref'],
      title: flags['title'],
      since: flags['since'],
    });
    return success('push', 'find-similar', { count: records.length, records });
  }

  return failure('push', sub ?? 'unknown', 'validation', `Unknown push command: ${sub}`, 'Available: record, history, get, outcome, find-similar');
}
