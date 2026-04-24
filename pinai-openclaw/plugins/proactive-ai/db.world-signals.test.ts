/**
 * Tests for world_signals (formerly world_items) — verifies the rename
 * preserves behaviour and the new reference triple works.
 * See docs/plans/memory-architecture.mdx §三 (world_signals).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getWorldSignal,
  ingestWorldSignal,
  listWorldSignals,
  listWorldSignalsByIds,
  markWorldSignalsReferenced,
  resetDbForTests,
} from './db.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-world-sig-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('ingestWorldSignal: round-trip with all fields', async () => {
  await withTempHome(async () => {
    const row = await ingestWorldSignal({
      provider: 'google-news',
      streamType: 'headline',
      title: 'BTC ETF flow hits record',
      url: 'https://example.com/btc-etf-record',
      normalizedUrl: 'https://example.com/btc-etf-record',
      summary: 'Inflows to spot BTC ETFs hit a new high',
      publishedAt: '2026-04-23T08:00:00Z',
      topics: ['finance', 'crypto'],
      regions: ['global'],
      importance: 'high',
    });
    assert.equal(row.title, 'BTC ETF flow hits record');
    assert.equal(row.provider, 'google-news');
    assert.deepEqual(row.topics, ['finance', 'crypto']);
    assert.equal(row.importance, 'high');
    assert.equal(row.reference_count, 0);
    assert.deepEqual(row.referenced_by_runs, []);
  });
});

test('listWorldSignals: filters by provider + since', async () => {
  await withTempHome(async () => {
    await ingestWorldSignal({
      provider: 'google-news', title: 'a',
      url: 'https://x.com/a', normalizedUrl: 'https://x.com/a',
      publishedAt: '2026-04-22T00:00:00Z',
    });
    await ingestWorldSignal({
      provider: 'sec', title: 'b',
      url: 'https://x.com/b', normalizedUrl: 'https://x.com/b',
      publishedAt: '2026-04-23T00:00:00Z',
    });
    const news = await listWorldSignals({ provider: 'google-news' });
    assert.equal(news.length, 1);
    const recent = await listWorldSignals({ since: '2026-04-23T00:00:00Z' });
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.provider, 'sec');
  });
});

test('listWorldSignalsByIds: preserves input order', async () => {
  await withTempHome(async () => {
    const a = await ingestWorldSignal({
      provider: 'p', title: 'A', url: 'https://x/a', normalizedUrl: 'https://x/a',
    });
    const b = await ingestWorldSignal({
      provider: 'p', title: 'B', url: 'https://x/b', normalizedUrl: 'https://x/b',
    });
    const c = await ingestWorldSignal({
      provider: 'p', title: 'C', url: 'https://x/c', normalizedUrl: 'https://x/c',
    });
    const ordered = await listWorldSignalsByIds([c.id, a.id, b.id]);
    assert.deepEqual(ordered.map((r) => r.title), ['C', 'A', 'B']);
  });
});

test('ingestWorldSignal: ON CONFLICT(normalized_url) updates existing row', async () => {
  await withTempHome(async () => {
    const v1 = await ingestWorldSignal({
      provider: 'p', title: 'old', url: 'https://x/a', normalizedUrl: 'https://x/a',
      summary: 'old summary',
    });
    const v2 = await ingestWorldSignal({
      provider: 'p', title: 'new', url: 'https://x/a', normalizedUrl: 'https://x/a',
      summary: 'new summary',
    });
    assert.equal(v2.id, v1.id);                  // same row
    assert.equal(v2.title, 'new');
    const all = await listWorldSignals();
    assert.equal(all.length, 1);
  });
});

test('markWorldSignalsReferenced: bumps + dedupes + caps at 10', async () => {
  await withTempHome(async () => {
    const row = await ingestWorldSignal({
      provider: 'p', title: 't', url: 'https://x/x', normalizedUrl: 'https://x/x',
    });
    await markWorldSignalsReferenced([row.id], 'run-1');
    await markWorldSignalsReferenced([row.id], 'run-1');  // dedupe
    await markWorldSignalsReferenced([row.id], 'run-2');
    const after = await getWorldSignal(row.id);
    assert.equal(after!.reference_count, 3);
    assert.deepEqual(after!.referenced_by_runs, ['run-1', 'run-2']);

    for (let i = 3; i <= 15; i++) {
      await markWorldSignalsReferenced([row.id], `run-${i}`);
    }
    const final = await getWorldSignal(row.id);
    assert.equal(final!.referenced_by_runs.length, 10);
  });
});

