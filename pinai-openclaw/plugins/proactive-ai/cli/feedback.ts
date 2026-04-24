import { parseArgs, success, failure, readJsonFlag, readLimitFlag } from './shared.js';
import * as db from '../db.js';

export async function handleFeedback(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (sub === 'log') {
    if (!flags['kind']) return failure('feedback', 'log', 'validation', 'Missing --kind');
    const metadataRes = readJsonFlag(flags, 'metadata', 'feedback', 'log');
    if ('failure' in metadataRes) return metadataRes.failure;
    const record = await db.logFeedback({
      kind: flags['kind'],
      action: flags['action'],
      pushId: flags['push-id'],
      intentCardId: flags['intent-card-id'],
      source: flags['source'],
      basket: flags['basket'],
      value: flags['value'],
      text: flags['text'],
      metadata: metadataRes.value,
    });
    return success('feedback', 'log', record);
  }

  if (sub === 'list') {
    const limitRes = readLimitFlag(flags, 'feedback', 'list');
    if ('failure' in limitRes) return limitRes.failure;
    const records = await db.listFeedback({
      since: flags['since'],
      kind: flags['kind'],
      action: flags['action'],
      intentCardId: flags['intent-card-id'],
      limit: limitRes.value,
    });
    return success('feedback', 'list', { count: records.length, events: records });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('feedback', 'get', 'validation', 'Missing --id');
    const record = await db.getFeedback(flags['id']);
    if (!record) return failure('feedback', 'get', 'not_found', `Feedback event ${flags['id']} not found`);
    return success('feedback', 'get', record);
  }

  if (sub === 'stats') {
    const stats = await db.feedbackStats({ since: flags['since'], basket: flags['basket'] });
    return success('feedback', 'stats', stats);
  }

  return failure('feedback', sub ?? 'unknown', 'validation', `Unknown feedback command: ${sub}`, 'Available: log, list, get, stats');
}
