import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertBrowserToolAllowed,
  isBrowserMutationAction,
} from './control-state.js';

test('classifies browser actions that mutate the remote page', () => {
  assert.equal(isBrowserMutationAction('click'), true);
  assert.equal(isBrowserMutationAction('type'), true);
  assert.equal(isBrowserMutationAction('navigate'), true);
  assert.equal(isBrowserMutationAction('snapshot'), false);
  assert.equal(isBrowserMutationAction('list_tabs'), false);
  assert.equal(isBrowserMutationAction('console'), false);
});

test('rejects AI mutating browser tools while user has taken over', () => {
  assert.throws(
    () => assertBrowserToolAllowed({ controlMode: 'user' }, 'click'),
    /user is currently controlling/i,
  );

  assert.doesNotThrow(() => assertBrowserToolAllowed({ controlMode: 'user' }, 'snapshot'));
  assert.doesNotThrow(() => assertBrowserToolAllowed({ controlMode: 'ai' }, 'click'));
});
