import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ingestPersonalSignals, resetDbForTests } from '../db.ts';
import { collectSignals } from './sources.ts';

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pin-dreaming-sources-'));
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = root;
  resetDbForTests();
  try {
    return await fn();
  } finally {
    resetDbForTests();
    if (previous === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('collectSignals includes connector personal signals for profile dreaming', async () => {
  await withTempHome(async () => {
    await ingestPersonalSignals([
      {
        kind: 'connector.gmail.message',
        title: 'Google Scholar Alert',
        summary: 'New papers matched the user research interests.',
        source: 'connector:gmail',
        occurredAt: '2026-04-24T09:00:00Z',
        salience: 0.7,
        confidence: 0.8,
      },
      {
        kind: 'connector.gcal.event',
        title: 'Future placeholder Home event',
        summary: 'A future all-day placeholder should not affect today profile dreaming.',
        source: 'connector:gcal',
        occurredAt: '2100-01-01T00:00:00Z',
        salience: 0.9,
        confidence: 0.8,
      },
    ]);

    const result = await collectSignals('2026-04-24T00:00:00Z', '2026-04-24T23:59:59Z');

    assert.equal(result.status, 'ok');
    assert.equal(result.count, 1);
    assert.equal((result.normalized[0] as { kind?: string }).kind, 'connector.gmail.message');
  });
});
