import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeChatHistoryTurns } from './chat-history-merge.ts';

test('merges assistant+toolResult chain into one turn with ordered parts', () => {
  const raw = [
    { role: 'user', content: [{ type: 'text', text: '[Wed 2026-04-22 00:03 UTC] 你现在叫小黑' }], timestamp: 1000 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: '...' },
        { type: 'text', text: '好的！小黑，记住了' },
        { type: 'toolCall', id: 'w1', name: 'write', arguments: { path: 'memory/name.md' } },
        { type: 'toolCall', id: 'w2', name: 'write', arguments: { path: 'memory/persona.md' } },
      ],
      timestamp: 1100,
    },
    { role: 'toolResult', toolCallId: 'w1', content: [{ type: 'text', text: 'wrote 42 bytes' }], isError: false, timestamp: 1200 },
    { role: 'toolResult', toolCallId: 'w2', content: [{ type: 'text', text: 'wrote 128 bytes' }], isError: false, timestamp: 1300 },
    { role: 'assistant', content: [{ type: 'text', text: '搞定！现在我是小黑了' }], timestamp: 1400 },
  ];

  const merged = mergeChatHistoryTurns(raw);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    id: 'user-0',
    role: 'user',
    parts: [{ type: 'text', text: '你现在叫小黑' }],
    createdAt: 1000,
  });
  assert.equal(merged[1].role, 'assistant');
  assert.equal(merged[1].createdAt, 1100);
  assert.deepEqual(
    merged[1].parts.map((p) => (p.type === 'text' ? ['text', p.text] : ['tool-call', p.toolName, p.toolCallId, p.status])),
    [
      ['text', '好的！小黑，记住了'],
      ['tool-call', 'write', 'w1', 'ok'],
      ['tool-call', 'write', 'w2', 'ok'],
      ['text', '搞定！现在我是小黑了'],
    ],
  );
});

test('tool error is propagated to the matching tool-call part', () => {
  const raw = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'exec', arguments: { command: 'false' } }],
      timestamp: 2,
    },
    { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'exit 1' }], isError: true, timestamp: 3 },
  ];
  const merged = mergeChatHistoryTurns(raw);
  assert.equal(merged.length, 2);
  const tool = merged[1].parts[0];
  assert.equal(tool.type, 'tool-call');
  if (tool.type === 'tool-call') {
    assert.equal(tool.status, 'error');
    assert.equal(tool.meta, 'exit 1');
  }
});

test('detects pin CLI invocations via exec', () => {
  const raw = [
    { role: 'user', content: [{ type: 'text', text: 'show me' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'e1', name: 'exec', arguments: { command: 'pin profile get' } },
      ],
      timestamp: 2,
    },
    { role: 'toolResult', toolCallId: 'e1', content: [{ type: 'text', text: '{}' }], isError: false, timestamp: 3 },
  ];
  const merged = mergeChatHistoryTurns(raw);
  const tool = merged[1].parts[0];
  assert.equal(tool.type, 'tool-call');
  if (tool.type === 'tool-call') {
    assert.equal(tool.pinCommand, 'profile get');
  }
});

test('strips empty/orphan messages and skips thinking parts', () => {
  const raw = [
    { role: 'user', content: [], timestamp: 1 }, // empty → dropped
    { role: 'assistant', content: [{ type: 'thinking', text: 'private' }], timestamp: 2 }, // no text/tool → dropped
    { role: 'toolResult', toolCallId: 'orphan', content: [{ type: 'text', text: 'no parent' }], timestamp: 3 }, // orphan
    { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 4 },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 5 },
  ];
  const merged = mergeChatHistoryTurns(raw);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].parts[0].type === 'text' && merged[0].parts[0].text, 'hello');
  assert.equal(merged[1].parts[0].type === 'text' && merged[1].parts[0].text, 'hi');
});

test('hides card-chat bootstrap "The user opened ..." synthetic message', () => {
  const raw = [
    { role: 'user', content: [{ type: 'text', text: 'The user opened "Draft outreach". Suggested action: "Draft outreach". Confirm details briefly, then execute.' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Sure — drafting now.' }], timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: '[Wed 2026-04-22 00:03 UTC] Also add a call-to-action at the end.' }], timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'Added.' }], timestamp: 4 },
  ];
  const merged = mergeChatHistoryTurns(raw);
  assert.deepEqual(merged.map((m) => [m.role, m.parts[0].type === 'text' ? m.parts[0].text : '']), [
    ['assistant', 'Sure — drafting now.'],
    ['user', 'Also add a call-to-action at the end.'],
    ['assistant', 'Added.'],
  ]);
});

test('next user message closes the open assistant turn', () => {
  const raw = [
    { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'reply1' }], timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: 'second' }], timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'reply2' }], timestamp: 4 },
  ];
  const merged = mergeChatHistoryTurns(raw);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});
