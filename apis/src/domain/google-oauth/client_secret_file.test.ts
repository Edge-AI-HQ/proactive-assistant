import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GOOGLE_OAUTH_CLIENT_SECRET_DEFAULT_FILE,
  materializeGoogleOAuthClientSecretFromEnv,
  resolveGoogleOAuthClientSecretPath,
} from './client_secret_file.js';

test('materializeGoogleOAuthClientSecretFromEnv writes decoded json to target path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-secret-'));
  const target = path.join(root, 'google', 'client_secret.json');
  const payload = '{"installed":{"client_id":"abc"}}';
  const previous = process.env.GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64 = Buffer.from(payload, 'utf8').toString('base64');

  try {
    const result = materializeGoogleOAuthClientSecretFromEnv(target);
    assert.equal(result, target);
    assert.equal(fs.readFileSync(target, 'utf8'), `${payload}\n`);
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET_JSON_B64 = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGoogleOAuthClientSecretPath falls back to default runtime path', () => {
  const previous = process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH;

  try {
    assert.equal(
      resolveGoogleOAuthClientSecretPath(),
      GOOGLE_OAUTH_CLIENT_SECRET_DEFAULT_FILE,
    );
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH = previous;
  }
});
