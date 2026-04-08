import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAutoLoopState, saveAutoLoopState } from './pending-store.js';

describe('pending-store auto loop state', () => {
  let dataRoot = '';
  let previousPinDataRoot: string | undefined;

  beforeEach(() => {
    previousPinDataRoot = process.env['PIN_DATA_ROOT'];
    dataRoot = mkdtempSync(join(tmpdir(), 'proactive-ai-pending-store-'));
    process.env['PIN_DATA_ROOT'] = dataRoot;
  });

  afterEach(() => {
    if (previousPinDataRoot === undefined) {
      delete process.env['PIN_DATA_ROOT'];
    } else {
      process.env['PIN_DATA_ROOT'] = previousPinDataRoot;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('persists last loop timestamps and status across reads', () => {
    expect(loadAutoLoopState()).toEqual({
      lastStartedAt: null,
      lastFinishedAt: null,
      lastStatus: null,
    });

    saveAutoLoopState({
      lastStartedAt: '2026-04-08T10:00:00.000Z',
    });
    expect(loadAutoLoopState()).toEqual({
      lastStartedAt: '2026-04-08T10:00:00.000Z',
      lastFinishedAt: null,
      lastStatus: null,
    });

    saveAutoLoopState({
      lastFinishedAt: '2026-04-08T10:05:00.000Z',
      lastStatus: 'success',
    });
    expect(loadAutoLoopState()).toEqual({
      lastStartedAt: '2026-04-08T10:00:00.000Z',
      lastFinishedAt: '2026-04-08T10:05:00.000Z',
      lastStatus: 'success',
    });
  });
});
