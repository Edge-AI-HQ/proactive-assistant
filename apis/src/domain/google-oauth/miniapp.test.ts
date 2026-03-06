import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMiniGoogleReturnUrl } from './miniapp.js';

test('buildMiniGoogleReturnUrl appends connected state', () => {
  assert.equal(
    buildMiniGoogleReturnUrl('/mini', { status: 'connected' }),
    '/mini?google=connected&manage=1',
  );
});

test('buildMiniGoogleReturnUrl appends encoded error state', () => {
  assert.equal(
    buildMiniGoogleReturnUrl('/mini', {
      status: 'error',
      error: 'oauth_failed',
    }),
    '/mini?google=error&manage=1&reason=oauth_failed',
  );
});
