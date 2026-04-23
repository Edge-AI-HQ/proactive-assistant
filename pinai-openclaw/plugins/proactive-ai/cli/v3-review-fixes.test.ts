/**
 * Regression tests for the teammate code-review batch:
 * - P1: garbage numeric flags must return VALIDATION, not throw RangeError
 * - P1: device-contacts search must filter in SQL (not after LIMIT)
 * - P2: gcal ingest must normalize start_at to UTC; today/week must honor --timezone
 * - P2: memory add must fail loud on invalid --quality / --confidence
 * - P2: memory search must find matches beyond the previous 500-row prefetch
 * - P3: device-contacts `search` requires --query (else it silently lists all)
 *
 * See docs/memory-architecture.md §五 / §六.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleMemory } from './memory.ts';
import { handleSignals } from './signals.ts';
import { handleRaw } from './raw.ts';

import {
  addMemoryV3,
  resetDbForTests,
} from '../db.ts';
import {
  ingestDeviceContactsSnapshot,
  ingestGcalEvents,
  listGcalEvents,
  resetRawDbForTests,
} from '../raw-db.ts';

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-v3-review-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn(root);
  } finally {
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function decode(raw: string): { ok: boolean; data: any; error: any } {
  return JSON.parse(raw);
}

// ─── P1 #1 — numeric validation on --hours / --limit ───────────────────

test('pin signals recent --hours abc: returns VALIDATION, does not throw', async () => {
  await withTempHome(async () => {
    const r = decode(await handleSignals(['recent', '--hours', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('hours'));
  });
});

test('pin signals recent --limit NaN: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleSignals(['recent', '--limit', 'not-a-number']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin raw gmail recent --hours garbage: returns VALIDATION, not RangeError', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gmail', 'recent', '--hours', 'junk']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

test('pin raw device-apps --top abc: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['device-apps', '--top', 'abc']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

// ─── P1 #2 — device-contacts search must filter in SQL, then LIMIT ─────

test('pin raw device-contacts search finds match beyond default LIMIT', async () => {
  await withTempHome(async () => {
    // Build 300 contacts sorted by display_name; plant the needle at
    // position 280 so a pre-LIMIT-200 path would miss it.
    const contacts = [] as Array<{ displayName: string; emails?: string[] }>;
    for (let i = 0; i < 300; i++) {
      contacts.push({ displayName: `User ${String(i).padStart(3, '0')}` });
    }
    // Replace one entry near the end with a unique pattern we can search for.
    contacts[280] = { displayName: 'User 280 UNIQUEPATTERN_ZZZ' };
    ingestDeviceContactsSnapshot({ deviceId: 'dev-long', contacts });

    const r = decode(await handleRaw([
      'device-contacts', 'search', '--query', 'UNIQUEPATTERN_ZZZ',
      '--deviceId', 'dev-long', '--limit', '50',
    ]));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1, 'search must find the row even when it sorts beyond LIMIT rows');
    assert.ok(r.data.contacts[0].display_name.includes('UNIQUEPATTERN_ZZZ'));
  });
});

test('pin raw device-contacts search is case-insensitive on email substrings', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd',
      contacts: [
        { displayName: 'Alice', emails: ['Alice.Chen@Example.COM'] },
        { displayName: 'Bob', emails: ['bob@other.com'] },
      ],
    });
    const r = decode(await handleRaw([
      'device-contacts', 'search', '--query', 'alice.chen', '--deviceId', 'd',
    ]));
    assert.equal(r.data.count, 1);
  });
});

// ─── P2 #3 — gcal ingest normalizes start_at; today/week honor --timezone ──

test('gcal ingest normalizes start_at from +08:00 offset to UTC Z', async () => {
  await withTempHome(async () => {
    ingestGcalEvents([
      { calendarId: 'cal1', eventId: 'e-sh',
        startAt: '2026-04-23T08:30:00+08:00', endAt: '2026-04-23T09:30:00+08:00', title: 'SH morning' },
      { calendarId: 'cal1', eventId: 'e-utc',
        startAt: '2026-04-23T00:30:00Z', endAt: '2026-04-23T01:30:00Z', title: 'UTC match' },
    ]);
    const rows = listGcalEvents();
    const sh = rows.find((r) => r.event_id === 'e-sh')!;
    const utc = rows.find((r) => r.event_id === 'e-utc')!;
    assert.equal(sh.start_at, '2026-04-23T00:30:00.000Z', 'Shanghai 08:30+08:00 should be UTC 00:30Z');
    assert.ok(utc.start_at!.endsWith('Z'));
  });
});

test('gcal listGcalEvents with mixed-offset since bound now works', async () => {
  await withTempHome(async () => {
    ingestGcalEvents([
      { calendarId: 'c', eventId: 'a', startAt: '2026-04-23T08:30:00+08:00' },   // = 00:30 Z
      { calendarId: 'c', eventId: 'b', startAt: '2026-04-23T16:00:00+08:00' },   // = 08:00 Z
    ]);
    // Caller passes a non-UTC bound — after normalization this must match event a.
    const rows = listGcalEvents({ since: '2026-04-23T08:00:00+08:00', until: '2026-04-23T12:00:00+08:00' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_id, 'a');
  });
});

test('pin raw gcal today --timezone Asia/Shanghai reports the SH day window', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gcal', 'today', '--timezone', 'Asia/Shanghai']));
    assert.equal(r.ok, true);
    assert.equal(r.data.timezone, 'Asia/Shanghai');
    // Window should be exactly 24h wide, both bounds UTC ISO, and the
    // `since` should be UTC midnight relative to Shanghai (i.e. ending in
    // ":00:00.000Z" at either 16:00Z previous day or 00:00Z depending on
    // when the test runs). Just assert shape + width here.
    const since = new Date(r.data.since);
    const until = new Date(r.data.until);
    const widthMs = until.getTime() - since.getTime();
    assert.equal(widthMs, 24 * 3600 * 1000);
    assert.ok(/\.000Z$/.test(r.data.since));
  });
});

test('pin raw gcal week --timezone has a 7-day window', async () => {
  await withTempHome(async () => {
    const r = decode(await handleRaw(['gcal', 'week', '--timezone', 'America/Los_Angeles']));
    assert.equal(r.ok, true);
    const widthMs = new Date(r.data.until).getTime() - new Date(r.data.since).getTime();
    assert.equal(widthMs, 7 * 24 * 3600 * 1000);
  });
});

// ─── P2 #4 — memory add fails loud on invalid --quality / --confidence ──

test('pin memory add --quality abc: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleMemory([
      'add', '--text', 'x', '--source', 'manual', '--quality', 'abc',
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('quality'));
  });
});

test('pin memory add --confidence garbage: returns VALIDATION', async () => {
  await withTempHome(async () => {
    const r = decode(await handleMemory([
      'add', '--text', 'x', '--source', 'manual', '--confidence', 'garbage',
    ]));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
  });
});

// ─── P2 #5 — memory search must find matches beyond the old 500 prefetch ──

test('pin memory search: finds row ranked far past 500 when sorted by quality', async () => {
  await withTempHome(async () => {
    // Seed >500 low-quality noise + one high-quality control + the needle.
    for (let i = 0; i < 510; i++) {
      await addMemoryV3({
        text: `noise ${i} lorem ipsum`,
        source: 'manual',
        subject: 'self',
        quality: 0.8,                       // noise dominates the top-N window
      });
    }
    await addMemoryV3({
      text: 'NEEDLE_TEXT_ZZZ — a very specific phrase',
      source: 'manual',
      subject: 'self',
      quality: 0.1,                         // low quality → would be ranked last
    });
    const r = decode(await handleMemory(['search', '--query', 'NEEDLE_TEXT_ZZZ', '--limit', '5']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 1, 'search must find the needle even when ranked past 500');
    assert.ok(r.data.memories[0].text.includes('NEEDLE_TEXT_ZZZ'));
  });
});

// ─── P3 #6 — device-contacts search requires --query ───────────────────

test('pin raw device-contacts search (no --query): returns VALIDATION', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd', contacts: [{ displayName: 'A' }],
    });
    const r = decode(await handleRaw(['device-contacts', 'search', '--deviceId', 'd']));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION');
    assert.ok(r.error.message.toLowerCase().includes('query'));
  });
});

test('pin raw device-contacts list (no --query) still lists the full snapshot', async () => {
  await withTempHome(async () => {
    ingestDeviceContactsSnapshot({
      deviceId: 'd', contacts: [{ displayName: 'A' }, { displayName: 'B' }],
    });
    const r = decode(await handleRaw(['device-contacts', 'list', '--deviceId', 'd']));
    assert.equal(r.ok, true);
    assert.equal(r.data.count, 2);
  });
});
