/**
 * Integration test: ingestMobileItems dual-writes to v3 personal_signals
 * and bridges snapshot payloads into raw.db device tables.
 * See docs/memory-architecture.md §四 (端侧协议兼容).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestMobileItems, listMobileItems, resetMobileDbForTests } from './mobile-db.ts';
import {
  listPersonalSignals,
  resetDbForTests,
} from './db.ts';
import {
  listDeviceApps,
  resetRawDbForTests,
} from './raw-db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-mobile-mirror-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetMobileDbForTests();
  resetDbForTests();
  resetRawDbForTests();
  try {
    return await fn();
  } finally {
    resetMobileDbForTests();
    resetDbForTests();
    resetRawDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

// Wait briefly for the async mirror (fire-and-forget) to flush.
async function waitForMirror(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('ingestMobileItems: legacy mobile_items table still receives the row', async () => {
  await withTempHome(async () => {
    const r = ingestMobileItems({
      deviceId: 'dev-1',
      items: [{
        id: 'm-1', itemType: 'attention_item', title: 'Mom', summary: 'msg',
        salience: 0.8, occurredAt: '2026-04-23T08:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
      }],
    });
    assert.equal(r.inserted, 1);
    const legacy = listMobileItems();
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]!.itemType, 'attention_item');
    // Wait for async mirror so cleanup doesn't race with v3 writes.
    await waitForMirror();
  });
});

test('ingestMobileItems: also mirrors into personal_signals (same id)', async () => {
  await withTempHome(async () => {
    ingestMobileItems({
      deviceId: 'dev-1',
      items: [{
        id: 'm-1',
        itemType: 'attention_item',
        title: 'New email from boss',
        summary: 'subject: Q2 plan',
        salience: 0.7,
        occurredAt: '2026-04-23T08:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      }],
    });
    await waitForMirror();
    const signals = await listPersonalSignals();
    assert.equal(signals.length, 1);
    const s = signals[0]!;
    assert.equal(s.id, 'm-1');                          // shared id for join
    assert.equal(s.kind, 'attention_item');
    assert.equal(s.title, 'New email from boss');
    assert.equal(s.salience, 0.7);
    assert.equal(s.device_id, 'dev-1');
    assert.equal(s.source, 'device');
    assert.equal(s.status, 'open');
  });
});

test('ingestMobileItems: dedupe_key falls back to mobile:<deviceId>:<id> when none provided', async () => {
  await withTempHome(async () => {
    ingestMobileItems({
      deviceId: 'dev-1',
      items: [{
        id: 'm-no-key', itemType: 'moment', title: 't', summary: 's',
        salience: 0.5, occurredAt: '2026-04-23T08:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
      }],
    });
    await waitForMirror();
    const signals = await listPersonalSignals();
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.dedupe_key, 'mobile:dev-1:m-no-key');
  });
});

test('ingestMobileItems: app_inventory_bootstrap bridges to raw.device_apps_snapshot', async () => {
  await withTempHome(async () => {
    ingestMobileItems({
      deviceId: 'dev-1',
      items: [{
        id: 'snap-1',
        itemType: 'app_inventory_bootstrap',
        title: 'Apps snapshot',
        summary: '40 apps installed',
        salience: 0.5,
        occurredAt: '2026-04-23T08:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        payload: {
          apps: [
            { bundleId: 'com.tencent.wechat', appName: 'WeChat', version: '8.0.50' },
            { bundleId: 'com.alibaba.alipay', appName: 'Alipay', version: '10.5.0' },
            { bundleId: 'com.spotify.music', appName: 'Spotify' },
          ],
        },
      }],
    });
    await waitForMirror();

    // Personal signals row should also be present (one entry for the
    // whole snapshot, payload kept).
    const signals = await listPersonalSignals();
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.kind, 'app_inventory_bootstrap');

    // raw.db.device_apps_snapshot should hold per-app rows.
    const apps = listDeviceApps({ deviceId: 'dev-1', latestSnapshotOnly: true });
    assert.equal(apps.length, 3);
    const names = apps.map((a) => a.app_name).sort();
    assert.deepEqual(names, ['Alipay', 'Spotify', 'WeChat']);
  });
});

test('ingestMobileItems: alternative payload key shapes are tolerated', async () => {
  await withTempHome(async () => {
    ingestMobileItems({
      deviceId: 'dev-1',
      items: [{
        id: 'snap-2',
        itemType: 'app_inventory_bootstrap',
        title: '...', summary: '...',
        salience: 0.5,
        occurredAt: '2026-04-23T08:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
        // Use snake_case keys (Android serialization preference)
        payload: {
          installedApps: [
            { bundle_id: 'com.x', app_name: 'X', last_used_at: '2026-04-22T20:00:00Z' },
          ],
        },
      }],
    });
    await waitForMirror();
    const apps = listDeviceApps({ deviceId: 'dev-1', latestSnapshotOnly: true });
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.bundle_id, 'com.x');
    assert.equal(apps[0]!.app_name, 'X');
  });
});

test('ingestMobileItems: re-ingesting the same item does NOT double-mirror', async () => {
  await withTempHome(async () => {
    const item = {
      id: 'm-dup', itemType: 'moment', title: 't', summary: 's', salience: 0.5,
      occurredAt: '2026-04-23T08:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
      dedupeKey: 'k:dup',
    };
    ingestMobileItems({ deviceId: 'dev-1', items: [item] });
    await waitForMirror();
    ingestMobileItems({ deviceId: 'dev-1', items: [item] });
    await waitForMirror();
    const signals = await listPersonalSignals();
    assert.equal(signals.length, 1);
  });
});
