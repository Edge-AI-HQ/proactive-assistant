import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoogleCredentialRemoveShell,
  buildGoogleCredentialWriteShell,
} from './hot_sync.js';

test('buildGoogleCredentialWriteShell decodes credential and copies to gws default path', () => {
  const shell = buildGoogleCredentialWriteShell(
    'eyJmb28iOiJiYXIifQ==',
    '/app/google/gws-credentials.json',
    '/root/.config/gws/credentials.json',
  );

  assert.match(shell, /mkdir -p '\/app\/google' '\/root\/.config\/gws'/);
  assert.match(shell, /printf %s 'eyJmb28iOiJiYXIifQ==' \| base64 -d > '\/app\/google\/gws-credentials\.json'/);
  assert.match(shell, /cp '\/app\/google\/gws-credentials\.json' '\/root\/.config\/gws\/credentials\.json'/);
});

test('buildGoogleCredentialRemoveShell deletes both credential files', () => {
  const shell = buildGoogleCredentialRemoveShell(
    '/app/google/gws-credentials.json',
    '/root/.config/gws/credentials.json',
  );

  assert.equal(shell, "rm -f '/app/google/gws-credentials.json' '/root/.config/gws/credentials.json'");
});

test('buildGoogleCredentialWriteShell rejects invalid base64 payload', () => {
  assert.throws(
    () => buildGoogleCredentialWriteShell('not valid@', '/app/google/gws-credentials.json', '/root/.config/gws/credentials.json'),
    /invalid google credential payload/i,
  );
});
