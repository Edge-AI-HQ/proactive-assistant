/**
 * Regression: cli/personal.ts and dreaming/sources.ts used to have two
 * separate Composio key lookups. The CLI checked file→env (correct).
 * Dreaming checked env only — so when the apis-side container provider
 * mounted the user key as a file (the production layout), dreaming
 * always reported "COMPOSIO_API_KEY is not configured" and skipped
 * personal data entirely.
 *
 * Both now share resolveComposioApiKey from this module. These tests
 * lock that contract so future edits can't reintroduce the divergence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveComposioApiKey, requireComposioApiKey, getComposioUserId } from './composio-key.ts';

async function withClearedComposioEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.COMPOSIO_API_KEY;
  const prevFile = process.env.COMPOSIO_API_KEY_FILE;
  const prevUser = process.env.COMPOSIO_USER_ID;
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_API_KEY_FILE;
  delete process.env.COMPOSIO_USER_ID;
  try {
    return await fn();
  } finally {
    if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = prevKey;
    if (prevFile === undefined) delete process.env.COMPOSIO_API_KEY_FILE; else process.env.COMPOSIO_API_KEY_FILE = prevFile;
    if (prevUser === undefined) delete process.env.COMPOSIO_USER_ID; else process.env.COMPOSIO_USER_ID = prevUser;
  }
}

test('resolveComposioApiKey: file at COMPOSIO_API_KEY_FILE wins', async () => {
  await withClearedComposioEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'composio-key-'));
    const file = join(dir, 'composio-api-key');
    await writeFile(file, 'ak_FROMFILE_xxx\n', 'utf-8');
    process.env.COMPOSIO_API_KEY_FILE = file;
    process.env.COMPOSIO_API_KEY = 'ak_FROMENV_xxx';
    try {
      const r = resolveComposioApiKey();
      assert.deepEqual(r, { key: 'ak_FROMFILE_xxx', source: 'user' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('resolveComposioApiKey: falls back to env when file missing', async () => {
  await withClearedComposioEnv(async () => {
    process.env.COMPOSIO_API_KEY_FILE = '/tmp/definitely-does-not-exist-' + Date.now();
    process.env.COMPOSIO_API_KEY = 'ak_FROMENV_xxx';
    const r = resolveComposioApiKey();
    assert.deepEqual(r, { key: 'ak_FROMENV_xxx', source: 'env' });
  });
});

test('resolveComposioApiKey: returns null when neither set', async () => {
  await withClearedComposioEnv(async () => {
    process.env.COMPOSIO_API_KEY_FILE = '/tmp/missing-' + Date.now();
    assert.equal(resolveComposioApiKey(), null);
  });
});

test('requireComposioApiKey: throws same message dreaming used to throw', async () => {
  await withClearedComposioEnv(async () => {
    process.env.COMPOSIO_API_KEY_FILE = '/tmp/missing-' + Date.now();
    assert.throws(
      () => requireComposioApiKey(),
      /COMPOSIO_API_KEY is not configured/,
    );
  });
});

test('getComposioUserId: prefers COMPOSIO_USER_ID, falls back to PROACTIVE_USER_ID, then default', async () => {
  await withClearedComposioEnv(async () => {
    const prevProactive = process.env.PROACTIVE_USER_ID;
    delete process.env.PROACTIVE_USER_ID;
    try {
      assert.equal(getComposioUserId(), 'default');
      process.env.PROACTIVE_USER_ID = 'proactive-uid';
      assert.equal(getComposioUserId(), 'proactive-uid');
      process.env.COMPOSIO_USER_ID = 'composio-uid';
      assert.equal(getComposioUserId(), 'composio-uid');
    } finally {
      if (prevProactive === undefined) delete process.env.PROACTIVE_USER_ID;
      else process.env.PROACTIVE_USER_ID = prevProactive;
    }
  });
});

test('regression: dreaming + cli now share the same lookup (no env, file present → both find it)', async () => {
  // This locks the bug fix: when the user key is mounted as a file (the
  // production layout) and no env var is set, both code paths must find
  // it. Previously dreaming would throw "not configured" here.
  await withClearedComposioEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'composio-key-regr-'));
    const file = join(dir, 'composio-api-key');
    await writeFile(file, 'ak_USERMOUNTED\n', 'utf-8');
    process.env.COMPOSIO_API_KEY_FILE = file;
    try {
      assert.equal(requireComposioApiKey(), 'ak_USERMOUNTED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
