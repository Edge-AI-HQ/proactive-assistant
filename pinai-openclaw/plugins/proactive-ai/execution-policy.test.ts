import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  classifyComposioToolSlug,
  validateComposioExecTool,
  shouldBlockBrowserOpen,
  isPinGroundingCommand,
  renderToolDecisionPolicyBlock,
} from './execution-policy.ts';

test('classifyComposioToolSlug: read tools are allowed by verb across toolkits', () => {
  assert.deepEqual(classifyComposioToolSlug('GMAIL_FETCH_EMAILS'), {
    kind: 'read',
    verb: 'FETCH',
  });
  assert.deepEqual(classifyComposioToolSlug('SLACK_SEARCH_MESSAGES'), {
    kind: 'read',
    verb: 'SEARCH',
  });
});

test('classifyComposioToolSlug: safe writes are verb-based across toolkits', () => {
  assert.deepEqual(classifyComposioToolSlug('GOOGLECALENDAR_CREATE_EVENT'), {
    kind: 'safe_write',
    verb: 'CREATE',
  });
  assert.deepEqual(classifyComposioToolSlug('SLACK_SEND_MESSAGE'), {
    kind: 'safe_write',
    verb: 'SEND',
  });
  assert.deepEqual(classifyComposioToolSlug('NOTION_UPDATE_PAGE'), {
    kind: 'safe_write',
    verb: 'UPDATE',
  });
});

test('classifyComposioToolSlug: dangerous writes are not covered by normal side-effect approval', () => {
  assert.deepEqual(classifyComposioToolSlug('GOOGLECALENDAR_DELETE_EVENT'), {
    kind: 'dangerous_write',
    verb: 'DELETE',
  });
  assert.deepEqual(classifyComposioToolSlug('STRIPE_CREATE_CHARGE'), {
    kind: 'dangerous_write',
    verb: 'CHARGE',
  });
});

test('validateComposioExecTool: safe writes need explicit side-effect approval', () => {
  assert.match(
    validateComposioExecTool('SLACK_SEND_MESSAGE', { allowSideEffect: false }) ?? '',
    /requires --allow-side-effect true/,
  );
  assert.equal(
    validateComposioExecTool('SLACK_SEND_MESSAGE', { allowSideEffect: true }),
    null,
  );
});

test('validateComposioExecTool: direct Gmail send stays blocked even with approval flag', () => {
  assert.match(
    validateComposioExecTool('GMAIL_SEND_EMAIL', { allowSideEffect: true }) ?? '',
    /GMAIL_SEND_EMAIL.*draft/i,
  );
});

test('validateComposioExecTool: dangerous writes are rejected until stronger approval exists', () => {
  assert.match(
    validateComposioExecTool('GOOGLECALENDAR_DELETE_EVENT', { allowSideEffect: true }) ?? '',
    /dangerous/i,
  );
});

test('isPinGroundingCommand recognizes Tier 1 and Tier 2 grounding', () => {
  assert.equal(isPinGroundingCommand('pin raw gmail recent --hours 24'), true);
  assert.equal(isPinGroundingCommand('pin memory search --query sarah'), true);
  assert.equal(isPinGroundingCommand('pin personal exec --tool GMAIL_FETCH_EMAILS'), true);
  assert.equal(isPinGroundingCommand('echo ok'), false);
});

test('shouldBlockBrowserOpen blocks browser open before pin grounding', () => {
  const result = shouldBlockBrowserOpen({
    toolName: 'browser',
    toolArgs: { action: 'open', url: 'https://mail.google.com' },
    priorToolCallsInRun: [],
    userMessage: 'check my emails',
  });
  assert.equal(result.block, true);
  assert.match(result.reason ?? '', /LAST-RESORT|Tier/i);
});

test('shouldBlockBrowserOpen allows browser retry after one policy block', () => {
  const result = shouldBlockBrowserOpen({
    toolName: 'browser',
    toolArgs: { action: 'open', url: 'https://mail.google.com' },
    priorToolCallsInRun: [
      { name: 'browser', args: { action: 'open', url: 'https://mail.google.com' }, blocked: true },
    ],
    userMessage: 'check my emails',
  });
  assert.equal(result.block, false);
});

test('renderToolDecisionPolicyBlock is the prompt single source for Tier wording', () => {
  const block = renderToolDecisionPolicyBlock();
  assert.match(block, /Tier 1/);
  assert.match(block, /Tier 2/);
  assert.match(block, /Tier 3/);
  assert.match(block, /read_web/);
  assert.match(block, /GMAIL_SEND_EMAIL/);
});

test('pin skill doc stays aligned with execution policy keywords', () => {
  const skill = readFileSync(new URL('../../image/skills/pin/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /read_web\(url, intent\)/);
  assert.match(skill, /GET \/ FETCH \/ SEARCH \/ LIST \/ READ \/ QUERY \/ LOOKUP \/[\s\S]*RETRIEVE \/ FIND/);
  assert.match(skill, /CREATE \/ UPDATE \/ SEND \/ POST \/ REPLY \/ DRAFT \/ SCHEDULE \/ PUBLISH \/[\s\S]*UPLOAD/);
  assert.match(skill, /DELETE \/ REMOVE \/ CANCEL \/ TRANSFER \/ CHARGE \/[\s\S]*PAY \/ PURCHASE \/ ARCHIVE \/ MOVE \/ EXECUTE \/ RUN/);
  assert.match(skill, /GMAIL_SEND_EMAIL[\s\S]*GMAIL_CREATE_EMAIL_DRAFT[\s\S]*GMAIL_SEND_DRAFT/);
  assert.doesNotMatch(skill, /Public PCI 只允许这个 allowlist/);
});
