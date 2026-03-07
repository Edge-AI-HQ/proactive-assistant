import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleConnectedMessage, extractStartPayload } from './startPayload.js';

test('extractStartPayload parses telegram deep-link payload', () => {
  assert.equal(extractStartPayload('/start google_connected'), 'google_connected');
  assert.equal(extractStartPayload('/start@smile_gog_test_bot google_connected'), 'google_connected');
  assert.equal(extractStartPayload('/start'), '');
});

test('buildGoogleConnectedMessage includes mailbox and suggested actions', () => {
  const message = buildGoogleConnectedMessage('smile@pinai.io');
  assert.match(message, /smile@pinai\.io/);
  assert.match(message, /latest 10 emails/);
  assert.match(message, /unread emails/);
});
