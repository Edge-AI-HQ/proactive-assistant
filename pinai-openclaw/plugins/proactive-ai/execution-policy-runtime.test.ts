import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearExecutionPolicyRunContext,
  evaluateBeforeToolCallForExecutionPolicy,
  registerExecutionPolicyRunContext,
} from './execution-policy-runtime.ts';

test('execution policy hook blocks browser open before any pin grounding', () => {
  const runId = 'run-policy-block';
  registerExecutionPolicyRunContext({
    runId,
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    userMessage: 'check my Gmail',
  });
  try {
    const result = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'browser',
      params: { action: 'open', url: 'https://mail.google.com' },
      runId,
      toolCallId: 'call-browser-1',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });
    assert.equal(result.block, true);
    assert.match(result.blockReason ?? '', /LAST-RESORT|Tier/i);
  } finally {
    clearExecutionPolicyRunContext(runId);
  }
});

test('blocked browser open does not reach BrowserbaseManager.createSession', async () => {
  const runId = 'run-policy-no-create-session';
  let browserbaseCreateSessionCalls = 0;
  const browserbaseManager = {
    createSession: async (_opts: { subagentId: string; url: string }) => {
      browserbaseCreateSessionCalls++;
      return { id: 'browser-session' };
    },
  };
  registerExecutionPolicyRunContext({
    runId,
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    userMessage: 'check my Gmail',
  });
  try {
    const hookResult = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'browser',
      params: { action: 'open', url: 'https://mail.google.com' },
      runId,
      toolCallId: 'call-browser-1',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });

    if (!hookResult.block) {
      await browserbaseManager.createSession({
        subagentId: 'agent:main:proactive-ai:chat-stream:test',
        url: 'https://mail.google.com',
      });
    }

    assert.equal(hookResult.block, true);
    assert.equal(browserbaseCreateSessionCalls, 0);
  } finally {
    clearExecutionPolicyRunContext(runId);
  }
});

test('execution policy hook records blocked browser call so retry can pass', () => {
  const runId = 'run-policy-retry';
  registerExecutionPolicyRunContext({
    runId,
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    userMessage: 'check my Gmail',
  });
  try {
    const first = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'browser',
      params: { action: 'open', url: 'https://mail.google.com' },
      runId,
      toolCallId: 'call-browser-1',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });
    assert.equal(first.block, true);

    const second = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'browser',
      params: { action: 'open', url: 'https://mail.google.com' },
      runId,
      toolCallId: 'call-browser-2',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });
    assert.equal(second.block, false);
  } finally {
    clearExecutionPolicyRunContext(runId);
  }
});

test('execution policy hook lets browser through after same-host read_web', () => {
  const runId = 'run-policy-grounded';
  registerExecutionPolicyRunContext({
    runId,
    sessionKey: 'agent:main:proactive-ai:chat-stream:test',
    userMessage: 'tell me about this page',
  });
  try {
    const readWeb = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'read_web',
      params: { url: 'https://example.com/article' },
      runId,
      toolCallId: 'call-read-web',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });
    assert.equal(readWeb.block, false);

    const browser = evaluateBeforeToolCallForExecutionPolicy({
      toolName: 'browser',
      params: { action: 'open', url: 'https://example.com/article' },
      runId,
      toolCallId: 'call-browser',
    }, { sessionKey: 'agent:main:proactive-ai:chat-stream:test' });
    assert.equal(browser.block, false);
  } finally {
    clearExecutionPolicyRunContext(runId);
  }
});
