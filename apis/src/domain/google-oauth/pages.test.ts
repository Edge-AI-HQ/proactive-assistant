import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGoogleCallbackPage } from './pages.js';

test('renderGoogleCallbackPage includes mailbox, bot link, and suggested actions', () => {
  const html = renderGoogleCallbackPage({
    title: 'Google connected',
    message: 'Google OAuth connected and token stored.',
    email: 'smile@pinai.io',
    botUrl: 'https://t.me/smile_gog_test_bot?start=google_connected',
  });

  assert.match(html, /smile@pinai\.io/);
  assert.match(html, /Return to Telegram/);
  assert.match(html, /latest emails/);
  assert.match(html, /google_connected/);
});
