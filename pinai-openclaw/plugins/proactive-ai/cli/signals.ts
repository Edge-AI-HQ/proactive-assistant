/**
 * `pin signals ...` — v3 personal_signals CLI.
 * See docs/memory-architecture.md §六.
 */
import { parseArgs, success, failure } from './shared.js';
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
    const hours = Number(flags['hours'] ?? '24');
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const limit = flags['limit'] ? Number(flags['limit']) : 30;
    const minSalience = flags['minSalience'] ? Number(flags['minSalience']) : undefined;
    const rows = await db.listPersonalSignals({
      status: (flags['status'] as db.PersonalSignalStatus | undefined) ?? 'open',
      kind: flags['kind'],
      source: flags['source'],
      deviceId: flags['deviceId'] ?? flags['device-id'],
      since,
      minSalience,
      limit,
      pruneExpired: true,
    });
    return success('signals', 'recent', { since, count: rows.length, signals: rows });
  }

  if (sub === 'list') {
    const limit = flags['limit'] ? Number(flags['limit']) : 50;
    const minSalience = flags['minSalience'] ? Number(flags['minSalience']) : undefined;
    const rows = await db.listPersonalSignals({
      status: (flags['status'] as db.PersonalSignalStatus | undefined) ?? 'open',
      kind: flags['kind'],
      source: flags['source'],
      deviceId: flags['deviceId'] ?? flags['device-id'],
      since: flags['since'],
      until: flags['until'],
      minSalience,
      limit,
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
