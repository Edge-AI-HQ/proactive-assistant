import test from 'node:test';
import assert from 'node:assert/strict';

import { isBackgroundAutoLoopTasksEnabled } from './background-auto-loop-tasks.ts';

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
  if (value === undefined) delete process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
  else process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED;
    else process.env.BACKGROUND_AUTO_LOOP_TASKS_ENABLED = previous;
  }
}

test('isBackgroundAutoLoopTasksEnabled: unset and empty default to enabled', async () => {
  await withFlag(undefined, async () => {
    assert.equal(isBackgroundAutoLoopTasksEnabled(), true);
  });
  await withFlag('', async () => {
    assert.equal(isBackgroundAutoLoopTasksEnabled(), true);
  });
});

test('isBackgroundAutoLoopTasksEnabled: explicit disabled values turn it off', async () => {
  for (const value of ['0', 'false', 'off', 'no', 'disabled', ' FALSE ']) {
    await withFlag(value, async () => {
      assert.equal(isBackgroundAutoLoopTasksEnabled(), false);
    });
  }
});

test('isBackgroundAutoLoopTasksEnabled: any other explicit value is enabled', async () => {
  for (const value of ['1', 'true', 'yes', 'enabled']) {
    await withFlag(value, async () => {
      assert.equal(isBackgroundAutoLoopTasksEnabled(), true);
    });
  }
});
