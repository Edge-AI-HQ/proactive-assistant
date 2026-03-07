import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveGoogleOAuthClientForTest,
  resetGoogleOAuthClientCacheForTest,
  sanitizeGoogleTokenPayload,
} from './service.js';

test('sanitizeGoogleTokenPayload strips raw oauth tokens but keeps profile fields', () => {
  const sanitized = sanitizeGoogleTokenPayload({
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    id_token: 'id-secret',
    scope: 'email profile',
    token_type: 'Bearer',
    expires_in: 3600,
    email: 'smile@pinai.io',
    name: 'Smile',
  });

  assert.deepEqual(sanitized, {
    scope: 'email profile',
    token_type: 'Bearer',
    expires_in: 3600,
    email: 'smile@pinai.io',
    name: 'Smile',
  });
});

test('resolveGoogleOAuthClientForTest caches parsed client secret file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-oauth-client-'));
  const secretFile = path.join(root, 'client_secret.json');
  fs.writeFileSync(
    secretFile,
    JSON.stringify({
      web: {
        client_id: 'client-id',
        client_secret: 'client-secret',
        redirect_uris: ['https://example.com/ignored'],
      },
    }),
    'utf8',
  );

  const previousPath = process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH;
  const previousRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH = secretFile;
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://pinclaw-api-dev.fly.dev/mini/google/callback';

  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads += 1;
    return originalReadFileSync(...args);
  }) as typeof fs.readFileSync;

  try {
    resetGoogleOAuthClientCacheForTest();
    const first = resolveGoogleOAuthClientForTest();
    const second = resolveGoogleOAuthClientForTest();

    assert.deepEqual(first, {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://pinclaw-api-dev.fly.dev/mini/google/callback',
    });
    assert.deepEqual(second, first);
    assert.equal(reads, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
    resetGoogleOAuthClientCacheForTest();
    if (previousPath === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET_PATH = previousPath;
    if (previousRedirect === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
    else process.env.GOOGLE_OAUTH_REDIRECT_URI = previousRedirect;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
