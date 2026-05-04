import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReadWebFetchOutcome,
  executeReadWeb,
} from './read-web-tool.ts';
import type { FetchResult } from '../cli/web.ts';

const baseFetchResult: FetchResult = {
  url: 'https://example.com/article',
  finalUrl: 'https://example.com/article',
  status: 200,
  contentType: 'text/html',
  byteCount: 1024,
  truncated: false,
  title: 'Example',
  text: 'This is a useful article with enough text to answer the user question.'.repeat(20),
};

test('classifyReadWebFetchOutcome keeps useful fetch output without browser upgrade', () => {
  const outcome = classifyReadWebFetchOutcome(baseFetchResult);
  assert.deepEqual(outcome, { upgrade: false });
});

test('classifyReadWebFetchOutcome upgrades sparse SPA-like output', () => {
  const outcome = classifyReadWebFetchOutcome({
    ...baseFetchResult,
    byteCount: 80,
    text: 'Loading...',
  });
  assert.equal(outcome.upgrade, true);
  assert.match(outcome.reason, /sparse|empty|SPA/i);
});

test('executeReadWeb returns fetch text when fetch is sufficient', async () => {
  const result = await executeReadWeb({
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    url: 'https://example.com/article',
    fetchUrlImpl: async () => baseFetchResult,
    openBrowserImpl: async () => {
      throw new Error('browser should not be opened');
    },
  });

  assert.equal(result.mode, 'fetch');
  assert.equal(result.upgraded, false);
  assert.equal(result.title, 'Example');
  assert.match(result.text, /useful article/);
});

test('executeReadWeb upgrades to browser when fetch is blocked by login wall', async () => {
  const result = await executeReadWeb({
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    url: 'https://example.com/dashboard',
    fetchUrlImpl: async () => {
      const err = new Error('HTTP 403 from https://example.com/dashboard');
      Object.assign(err, { code: 'http_error' });
      throw err;
    },
    openBrowserImpl: async () => 'Browser opened at https://example.com/dashboard\n\nbutton "Sign in" [ref=e1]',
  });

  assert.equal(result.mode, 'browser');
  assert.equal(result.upgraded, true);
  assert.match(result.upgradeReason ?? '', /403|login|auth/i);
  assert.match(result.text, /Sign in/);
});
