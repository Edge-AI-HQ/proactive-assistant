/**
 * `pin raw ...` — read-only access to raw.db (gmail / gcal / device snapshots).
 * See docs/memory-architecture.md §六.
 */
import { parseArgs, success, failure } from './shared.js';
import * as raw from '../raw-db.js';

export async function handleRaw(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('raw', 'help', {
      commands: ['gmail', 'gcal', 'device-apps', 'device-contacts'],
      examples: [
        'pin raw gmail recent --hours 24 --limit 20',
        'pin raw gmail thread --threadId <tid>',
        'pin raw gcal today',
        'pin raw gcal week',
        'pin raw device-apps --deviceId <id> --top 20',
        'pin raw device-contacts search --query "张"',
      ],
    });
  }

  if (sub === 'gmail') {
    const action = positional[1] ?? 'recent';
    if (action === 'recent') {
      const hours = Number(flags['hours'] ?? '24');
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const limit = flags['limit'] ? Number(flags['limit']) : 20;
      const messages = raw.listGmailMessages({ since, limit });
      return success('raw', 'gmail.recent', { since, count: messages.length, messages });
    }
    if (action === 'thread') {
      const threadId = flags['threadId'] ?? flags['thread-id'];
      if (!threadId) return failure('raw', 'gmail.thread', 'validation', 'Missing --threadId');
      const limit = flags['limit'] ? Number(flags['limit']) : 50;
      const messages = raw.listGmailMessages({ threadId, limit });
      return success('raw', 'gmail.thread', { threadId, count: messages.length, messages });
    }
    return failure('raw', `gmail.${action}`, 'validation', `Unknown gmail action: ${action}`,
      'Available: recent, thread');
  }

  if (sub === 'gcal') {
    const action = positional[1] ?? 'today';
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setUTCHours(23, 59, 59, 999);
    if (action === 'today') {
      const events = raw.listGcalEvents({
        since: todayStart.toISOString(), until: todayEnd.toISOString(),
        limit: 50,
      });
      return success('raw', 'gcal.today', { count: events.length, events });
    }
    if (action === 'week') {
      const weekEnd = new Date(todayEnd); weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      const events = raw.listGcalEvents({
        since: todayStart.toISOString(), until: weekEnd.toISOString(),
        limit: 100,
      });
      return success('raw', 'gcal.week', { count: events.length, events });
    }
    if (action === 'list') {
      const limit = flags['limit'] ? Number(flags['limit']) : 30;
      const events = raw.listGcalEvents({
        since: flags['since'], until: flags['until'],
        calendarId: flags['calendarId'] ?? flags['calendar-id'], limit,
      });
      return success('raw', 'gcal.list', { count: events.length, events });
    }
    return failure('raw', `gcal.${action}`, 'validation', `Unknown gcal action: ${action}`,
      'Available: today, week, list');
  }

  if (sub === 'device-apps') {
    const top = flags['top'] ? Number(flags['top']) : 20;
    const apps = raw.listDeviceApps({
      deviceId: flags['deviceId'] ?? flags['device-id'],
      latestSnapshotOnly: true,
      limit: top,
    });
    return success('raw', 'device-apps', { count: apps.length, apps });
  }

  if (sub === 'device-contacts') {
    return failure('raw', 'device-contacts', 'not_implemented',
      'pin raw device-contacts not yet wired (use SQL on raw.db.device_contacts_snapshot directly)');
  }

  return failure('raw', sub, 'validation', `Unknown raw command: ${sub}`,
    'Available: gmail, gcal, device-apps, device-contacts');
}
