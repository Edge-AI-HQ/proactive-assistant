/**
 * Tests for raw.db — source-typed tables for connector / device snapshots.
 * See docs/plans/memory-architecture.mdx §三 (raw.db).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ingestDeviceAppsSnapshot,
  ingestDeviceContactsSnapshot,
  ingestGcalEvents,
  ingestGmailMessages,
  listDeviceApps,
  listGcalEvents,
  listGmailMessages,
  markRawReferenced,
  resetRawDbForTests,
} from './raw-db.ts';

async function withTempHome<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-raw-db-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetRawDbForTests();
  try {
    return await fn(root);
  } finally {
    resetRawDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('raw.db file is created on first access', async () => {
  await withTempHome(async (root) => {
    ingestGmailMessages([{
      messageId: '18a-x', subject: 'hi', body: 'hello',
    }]);
    assert.ok(existsSync(join(root, 'data', 'raw.db')));
  });
});

// ─── Gmail ──────────────────────────────────────────────────────────────

test('ingestGmailMessages: idempotent on dedupe_key (default = gmail:msg:<id>)', async () => {
  await withTempHome(async () => {
    const r1 = ingestGmailMessages([
      { messageId: '18a-1', from: 'a@x.com', to: ['me@x.com'], subject: 'hi' },
    ]);
    const r2 = ingestGmailMessages([
      { messageId: '18a-1', from: 'a@x.com', subject: 'changed' },
    ]);
    assert.equal(r1.inserted, 1);
    assert.equal(r2.inserted, 0);
    const all = listGmailMessages();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.subject, 'hi');                 // original wins (INSERT OR IGNORE)
  });
});

test('listGmailMessages: filters since/until/threadId; sorted DESC', async () => {
  await withTempHome(async () => {
    ingestGmailMessages([
      { messageId: 'a', threadId: 't1', subject: 'first',  occurredAt: '2026-04-22T08:00:00Z' },
      { messageId: 'b', threadId: 't1', subject: 'second', occurredAt: '2026-04-23T08:00:00Z' },
      { messageId: 'c', threadId: 't2', subject: 'other',  occurredAt: '2026-04-23T09:00:00Z' },
    ]);
    const all = listGmailMessages();
    assert.deepEqual(all.map((m) => m.subject), ['other', 'second', 'first']);
    const t1 = listGmailMessages({ threadId: 't1' });
    assert.equal(t1.length, 2);
    const recent = listGmailMessages({ since: '2026-04-23T00:00:00Z' });
    assert.equal(recent.length, 2);
  });
});

test('ingestGmailMessages: JSON arrays are parsed back', async () => {
  await withTempHome(async () => {
    ingestGmailMessages([{
      messageId: 'm', to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'], labelIds: ['INBOX', 'IMPORTANT'],
    }]);
    const row = listGmailMessages()[0]!;
    assert.deepEqual(row.to_addrs, ['a@x.com', 'b@x.com']);
    assert.deepEqual(row.cc_addrs, ['c@x.com']);
    assert.deepEqual(row.label_ids, ['INBOX', 'IMPORTANT']);
  });
});

// ─── GCal ───────────────────────────────────────────────────────────────

test('ingestGcalEvents: dedupe via (calendarId, eventId) natural key', async () => {
  await withTempHome(async () => {
    const r1 = ingestGcalEvents([
      { calendarId: 'primary', eventId: 'evt-1', title: 'Standup', startAt: '2026-04-23T09:00:00Z' },
    ]);
    const r2 = ingestGcalEvents([
      { calendarId: 'primary', eventId: 'evt-1', title: 'Updated', startAt: '2026-04-23T10:00:00Z' },
    ]);
    assert.equal(r1.inserted, 1);
    assert.equal(r2.inserted, 0);
    const events = listGcalEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.title, 'Standup');
  });
});

test('listGcalEvents: filters by calendar_id + time window', async () => {
  await withTempHome(async () => {
    ingestGcalEvents([
      { calendarId: 'primary', eventId: 'a', startAt: '2026-04-23T09:00:00Z' },
      { calendarId: 'primary', eventId: 'b', startAt: '2026-04-24T09:00:00Z' },
      { calendarId: 'work', eventId: 'c', startAt: '2026-04-23T11:00:00Z' },
    ]);
    const primary = listGcalEvents({ calendarId: 'primary' });
    assert.equal(primary.length, 2);
    const today = listGcalEvents({ since: '2026-04-23T00:00:00Z', until: '2026-04-23T23:59:59Z' });
    assert.equal(today.length, 2);
  });
});

// ─── Device apps snapshot ───────────────────────────────────────────────

test('ingestDeviceAppsSnapshot: writes one row per app, shared snapshot_id', async () => {
  await withTempHome(async () => {
    const r = ingestDeviceAppsSnapshot({
      deviceId: 'dev-1',
      capturedAt: '2026-04-23T08:00:00Z',
      apps: [
        { bundleId: 'com.apple.mobilesafari', appName: 'Safari' },
        { bundleId: 'com.tencent.wechat', appName: 'WeChat', version: '8.0.50' },
      ],
    });
    assert.equal(r.inserted, 2);
    const apps = listDeviceApps({ deviceId: 'dev-1' });
    assert.equal(apps.length, 2);
    assert.equal(apps[0]!.snapshot_id, apps[1]!.snapshot_id);
  });
});

test('listDeviceApps: latestSnapshotOnly returns only the most recent batch', async () => {
  await withTempHome(async () => {
    ingestDeviceAppsSnapshot({
      deviceId: 'dev-1',
      capturedAt: '2026-04-22T08:00:00Z',
      apps: [{ bundleId: 'com.app1', appName: 'Old1' }],
    });
    ingestDeviceAppsSnapshot({
      deviceId: 'dev-1',
      capturedAt: '2026-04-23T08:00:00Z',
      apps: [
        { bundleId: 'com.app2', appName: 'New1' },
        { bundleId: 'com.app3', appName: 'New2' },
      ],
    });
    const latest = listDeviceApps({ deviceId: 'dev-1', latestSnapshotOnly: true });
    assert.equal(latest.length, 2);
    const names = latest.map((a) => a.app_name).sort();
    assert.deepEqual(names, ['New1', 'New2']);
  });
});

test('ingestDeviceAppsSnapshot: throws on missing deviceId', async () => {
  await withTempHome(async () => {
    assert.throws(
      () => ingestDeviceAppsSnapshot({ deviceId: '', apps: [{ bundleId: 'b', appName: 'a' }] }),
      /deviceId is required/,
    );
  });
});

// ─── Device contacts snapshot ───────────────────────────────────────────

test('ingestDeviceContactsSnapshot: stores emails/phones as JSON arrays', async () => {
  await withTempHome(async () => {
    const r = ingestDeviceContactsSnapshot({
      deviceId: 'dev-1',
      contacts: [
        { displayName: 'Mom', emails: ['mom@home.com'], phones: ['+8613800000000'] },
        { displayName: 'Boss', emails: ['boss@work.com', 'boss@personal.com'] },
      ],
    });
    assert.equal(r.inserted, 2);
  });
});

test('ingestDeviceContactsSnapshot: throws on missing deviceId', async () => {
  await withTempHome(async () => {
    assert.throws(
      () => ingestDeviceContactsSnapshot({ deviceId: '', contacts: [{ displayName: 'x' }] }),
      /deviceId is required/,
    );
  });
});

// ─── Reference triple ──────────────────────────────────────────────────

test('markRawReferenced: works uniformly across raw tables, caps at 10', async () => {
  await withTempHome(async () => {
    const r = ingestGmailMessages([{ messageId: 'm1' }]);
    const id = r.ids[0]!;
    markRawReferenced('gmail_messages', [id], 'run-1');
    markRawReferenced('gmail_messages', [id], 'run-1');  // dedupe
    markRawReferenced('gmail_messages', [id], 'run-2');
    const row = listGmailMessages()[0]!;
    assert.equal(row.reference_count, 3);
    assert.deepEqual(row.referenced_by_runs, ['run-1', 'run-2']);

    for (let i = 3; i <= 15; i++) {
      markRawReferenced('gmail_messages', [id], `run-${i}`);
    }
    const after = listGmailMessages()[0]!;
    assert.equal(after.referenced_by_runs.length, 10);
  });
});

test('markRawReferenced: throws on unknown table name (defense)', async () => {
  await withTempHome(async () => {
    assert.throws(
      () => markRawReferenced('not_a_table', ['id'], 'run-1'),
      /unknown raw table/,
    );
  });
});
