/**
 * `pin signals ...` — v3 personal_signals CLI.
 * See docs/plans/memory-architecture.mdx §六.
 */
import { parseArgs, success, failure, readNumericFlag, readLimitFlag } from './shared.js';
import * as db from '../db.js';

export async function handleSignals(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('signals', 'help', {
      commands: ['recent', 'list', 'get', 'consume'],
      examples: [
        'pin signals recent --hours 24 --limit 30',
        'pin signals list --status open --kind moment',
        'pin signals get --id <signal_id>',
        'pin signals consume --id <signal_id> --runId <run_id>',
      ],
    });
  }

  if (sub === 'recent') {
    const hoursRes = readNumericFlag(flags, ['hours'], 'signals', 'recent');
    if ('failure' in hoursRes) return hoursRes.failure;
    const limitRes = readLimitFlag(flags, 'signals', 'recent');
    if ('failure' in limitRes) return limitRes.failure;
    const minSalienceRes = readNumericFlag(flags, ['minSalience'], 'signals', 'recent');
    if ('failure' in minSalienceRes) return minSalienceRes.failure;
    const hours = hoursRes.value ?? 24;
    const until = new Date().toISOString();
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = await db.listPersonalSignals({
      status: (flags['status'] as db.PersonalSignalStatus | undefined) ?? 'open',
      kind: flags['kind'],
      source: flags['source'],
      deviceId: flags['deviceId'] ?? flags['device-id'],
      since,
      until,
      minSalience: minSalienceRes.value,
      limit: limitRes.value ?? 30,
      pruneExpired: true,
    });
    return success('signals', 'recent', { since, until, count: rows.length, signals: rows });
  }

  if (sub === 'list') {
    const limitRes = readLimitFlag(flags, 'signals', 'list');
    if ('failure' in limitRes) return limitRes.failure;
    const minSalienceRes = readNumericFlag(flags, ['minSalience'], 'signals', 'list');
    if ('failure' in minSalienceRes) return minSalienceRes.failure;
    const rows = await db.listPersonalSignals({
      status: (flags['status'] as db.PersonalSignalStatus | undefined) ?? 'open',
      kind: flags['kind'],
      source: flags['source'],
      deviceId: flags['deviceId'] ?? flags['device-id'],
      since: flags['since'],
      until: flags['until'],
      minSalience: minSalienceRes.value,
      limit: limitRes.value ?? 50,
    });
    return success('signals', 'list', { count: rows.length, signals: rows });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('signals', 'get', 'validation', 'Missing --id');
    const row = await db.getPersonalSignal(flags['id']);
    if (!row) return failure('signals', 'get', 'not_found', `Signal ${flags['id']} not found`);
    return success('signals', 'get', { signal: row });
  }

  if (sub === 'consume') {
    const id = flags['id'];
    const runId = flags['runId'] ?? flags['run-id'];
    if (!id) return failure('signals', 'consume', 'validation', 'Missing --id');
    if (!runId) return failure('signals', 'consume', 'validation', 'Missing --runId');
    const updated = await db.markPersonalSignalsConsumed([id], runId);
    return success('signals', 'consume', { id, runId, updated });
  }

  return failure('signals', sub, 'validation', `Unknown signals command: ${sub}`,
    'Available: recent, list, get, consume');
}
