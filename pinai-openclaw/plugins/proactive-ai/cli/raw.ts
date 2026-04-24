/**
 * `pin raw ...` — read-only access to raw.db (gmail / gcal / device snapshots).
 * See docs/plans/memory-architecture.mdx §六.
 */
import { parseArgs, success, failure, readNumericFlag, readLimitFlag } from './shared.js';
import * as raw from '../raw-db.js';
import { getProfile } from '../db.js';

/**
 * Resolve the timezone to use for today/week boundaries.
 *
 * Precedence: explicit --timezone flag → profile.timezone → process.env.TZ → 'UTC'.
 * Must be an IANA zone name that Intl.DateTimeFormat accepts.
 */
async function resolveTimezone(flag: string | undefined): Promise<string> {
  if (flag) return flag;
  try {
    const profile = await getProfile();
    if (profile?.timezone) return profile.timezone;
  } catch {
    // profile fetch may fail in tests before create; fall through
  }
  return process.env.TZ ?? 'UTC';
}

/**
 * Offset in minutes for a given IANA tz at a given instant.
 * Uses Intl.DateTimeFormat longOffset output (e.g. "GMT+08:00", "GMT-05:00").
 * Falls back to 0 (UTC) for unknown zones or if the format is unparseable.
 */
function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'longOffset',
      hour: 'numeric', hourCycle: 'h23',
    });
    const parts = dtf.formatToParts(at);
    const off = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (!off) return 0;
    if (off === 'GMT') return 0;
    const m = off.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return 0;
  }
}

/** Return the local-midnight (in tz) for `at`, as a UTC-ISO string. */
function localDayStartUtc(tz: string, at: Date): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const ymd = dtf.format(at); // "YYYY-MM-DD" in en-CA
  const offMin = tzOffsetMinutes(tz, at);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return new Date(`${ymd}T00:00:00${sign}${hh}:${mm}`).toISOString();
}

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
        'pin raw gcal today --timezone Asia/Shanghai',
        'pin raw gcal week',
        'pin raw gcal list --since 2026-04-23 --limit 30',
        'pin raw device-apps --deviceId <id> --top 20',
        'pin raw device-contacts list --deviceId <id> --limit 200',
        'pin raw device-contacts search --query "张" --deviceId <id>',
      ],
    });
  }

  if (sub === 'gmail') {
    const action = positional[1] ?? 'recent';
    if (action === 'recent') {
      const hoursRes = readNumericFlag(flags, ['hours'], 'raw', 'gmail.recent');
      if ('failure' in hoursRes) return hoursRes.failure;
      const limitRes = readLimitFlag(flags, 'raw', 'gmail.recent');
      if ('failure' in limitRes) return limitRes.failure;
      const hours = hoursRes.value ?? 24;
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const messages = raw.listGmailMessages({ since, limit: limitRes.value ?? 20 });
      return success('raw', 'gmail.recent', { since, count: messages.length, messages });
    }
    if (action === 'thread') {
      const threadId = flags['threadId'] ?? flags['thread-id'];
      if (!threadId) return failure('raw', 'gmail.thread', 'validation', 'Missing --threadId');
      const limitRes = readLimitFlag(flags, 'raw', 'gmail.thread');
      if ('failure' in limitRes) return limitRes.failure;
      const messages = raw.listGmailMessages({ threadId, limit: limitRes.value ?? 50 });
      return success('raw', 'gmail.thread', { threadId, count: messages.length, messages });
    }
    return failure('raw', `gmail.${action}`, 'validation', `Unknown gmail action: ${action}`,
      'Available: recent, thread');
  }

  if (sub === 'gcal') {
    const action = positional[1] ?? 'today';
    if (action === 'today') {
      const tz = await resolveTimezone(flags['timezone'] ?? flags['tz']);
      const now = new Date();
      const since = localDayStartUtc(tz, now);
      const until = new Date(new Date(since).getTime() + 24 * 3600 * 1000).toISOString();
      const events = raw.listGcalEvents({ since, until, limit: 50 });
      return success('raw', 'gcal.today', { timezone: tz, since, until, count: events.length, events });
    }
    if (action === 'week') {
      const tz = await resolveTimezone(flags['timezone'] ?? flags['tz']);
      const now = new Date();
      const since = localDayStartUtc(tz, now);
      const until = new Date(new Date(since).getTime() + 7 * 24 * 3600 * 1000).toISOString();
      const events = raw.listGcalEvents({ since, until, limit: 100 });
      return success('raw', 'gcal.week', { timezone: tz, since, until, count: events.length, events });
    }
    if (action === 'list') {
      const limitRes = readLimitFlag(flags, 'raw', 'gcal.list');
      if ('failure' in limitRes) return limitRes.failure;
      const events = raw.listGcalEvents({
        since: flags['since'], until: flags['until'],
        calendarId: flags['calendarId'] ?? flags['calendar-id'],
        limit: limitRes.value ?? 30,
      });
      return success('raw', 'gcal.list', { count: events.length, events });
    }
    return failure('raw', `gcal.${action}`, 'validation', `Unknown gcal action: ${action}`,
      'Available: today, week, list');
  }

  if (sub === 'device-apps') {
    const limitRes = readLimitFlag(flags, 'raw', 'device-apps');
    if ('failure' in limitRes) return limitRes.failure;
    const apps = raw.listDeviceApps({
      deviceId: flags['deviceId'] ?? flags['device-id'],
      // Default to latest snapshot only; pass --all-snapshots to disable
      latestSnapshotOnly: flags['all-snapshots'] !== 'true',
      since: flags['since'],
      until: flags['until'],
      limit: limitRes.value ?? 20,
    });
    return success('raw', 'device-apps', { count: apps.length, apps });
  }

  if (sub === 'device-contacts') {
    const action = positional[1] ?? 'list';
    if (action !== 'list' && action !== 'search') {
      return failure('raw', `device-contacts.${action}`, 'validation',
        `Unknown device-contacts action: ${action}`, 'Available: list, search');
    }
    const limitRes = readLimitFlag(flags, 'raw', `device-contacts.${action}`);
    if ('failure' in limitRes) return limitRes.failure;
    const query = flags['query'] ?? flags['search'] ?? flags['q'];
    // `search` semantically requires a query — otherwise fall through to list,
    // which would silently return the full snapshot and mislead the caller.
    if (action === 'search' && !query) {
      return failure('raw', 'device-contacts.search', 'validation',
        'Missing --query (search requires a non-empty query string)');
    }
    const contacts = raw.listDeviceContacts({
      deviceId: flags['deviceId'] ?? flags['device-id'],
      latestSnapshotOnly: flags['all-snapshots'] !== 'true',
      since: flags['since'],
      until: flags['until'],
      search: query,
      limit: limitRes.value ?? 200,
    });
    return success('raw', `device-contacts.${action}`, { count: contacts.length, contacts });
  }

  return failure('raw', sub, 'validation', `Unknown raw command: ${sub}`,
    'Available: gmail, gcal, device-apps, device-contacts');
}
