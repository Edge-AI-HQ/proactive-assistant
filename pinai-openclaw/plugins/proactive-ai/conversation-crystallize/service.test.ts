import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMainChatSessionKey,
  normalizeSynthesis,
  pairUserAssistantMessages,
  runCrystallize,
} from './service.ts';
import {
  DEFAULT_CRYSTALLIZE_CONFIG,
  type CrystallizeConfig,
  type CrystallizeSynthesis,
  type CrystallizeTurn,
} from './types.ts';

const cfg: CrystallizeConfig = { ...DEFAULT_CRYSTALLIZE_CONFIG };

function makeLogger() {
  const calls: Array<{ level: string; message: string }> = [];
  return {
    calls,
    info: (message: string) => calls.push({ level: 'info', message }),
    warn: (message: string) => calls.push({ level: 'warn', message }),
    error: (message: string) => calls.push({ level: 'error', message }),
    debug: (message: string) => calls.push({ level: 'debug', message }),
  };
}

function makeApi(logger = makeLogger()) {
  return {
    logger,
    runtime: {
      subagent: {
        run: async () => ({ runId: 'unused' }),
        waitForRun: async () => ({ status: 'ok' }),
        getSessionMessages: async () => ({ messages: [] }),
        deleteSession: async () => undefined,
      },
      events: { onAgentEvent: () => () => undefined },
    },
  } as never;
}

// ── isMainChatSessionKey ──

test('isMainChatSessionKey accepts main chat session keys', () => {
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:chat:abc'), true);
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:chat-test:abc'), true);
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:chat-stream:xyz'), true);
});

test('isMainChatSessionKey rejects card-chat, other prefixes and empty values', () => {
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:chat:card:card_1'), false);
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:chat-feedback:abc'), false);
  assert.equal(isMainChatSessionKey('agent:main:proactive-ai:crystallize:abc'), false);
  assert.equal(isMainChatSessionKey(''), false);
  assert.equal(isMainChatSessionKey(null), false);
  assert.equal(isMainChatSessionKey(undefined), false);
});

// ── pairUserAssistantMessages ──

test('pairUserAssistantMessages groups user+assistant and skips injected openers', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'The user opened card_1' },
    { role: 'assistant', content: 'card opener reply' },
    { role: 'user', content: 'please remember I like espresso' },
    { role: 'assistant', content: 'noted.' },
  ];
  const turns = pairUserAssistantMessages(messages, 'agent:main:proactive-ai:chat:x', cfg);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, 'hi');
  assert.equal(turns[0].assistantText, 'hello');
  assert.equal(turns[1].userText, 'please remember I like espresso');
  assert.equal(turns[1].assistantText, 'noted.');
});

test('pairUserAssistantMessages truncates to messageThreshold', () => {
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `u${i}` });
    msgs.push({ role: 'assistant', content: `a${i}` });
  }
  const turns = pairUserAssistantMessages(msgs, 'agent:main:proactive-ai:chat:x', cfg);
  assert.equal(turns.length, cfg.messageThreshold);
  assert.equal(turns[turns.length - 1].userText, 'u19');
});

// ── normalizeSynthesis ──

test('normalizeSynthesis forces discard below salience floor', () => {
  const result = normalizeSynthesis(
    {
      summary: 's',
      salience: 0.1,
      decision: 'memorize',
      memory: { kind: 'conversation_crystal', text: 'something', tags: [] },
    } satisfies CrystallizeSynthesis,
    cfg,
  );
  assert.equal(result.decision, 'discard');
  assert.equal(result.memory, undefined);
});

test('normalizeSynthesis keeps memorize decision with valid payload', () => {
  const result = normalizeSynthesis(
    {
      summary: 'user prefers async work',
      salience: 0.7,
      decision: 'memorize',
      memory: { kind: 'conversation_crystal', text: 'Prefers async over meetings.', tags: ['work'] },
    },
    cfg,
  );
  assert.equal(result.decision, 'memorize');
  assert.equal(result.memory?.text, 'Prefers async over meetings.');
  assert.deepEqual(result.memory?.tags, ['work']);
});

test('normalizeSynthesis downgrades create_skill without title or body to discard', () => {
  const result = normalizeSynthesis(
    {
      summary: 'x',
      salience: 0.8,
      decision: 'create_skill',
      skill: { title: '', bodyMarkdown: 'body', triggers: [] },
    },
    cfg,
  );
  assert.equal(result.decision, 'discard');
});

test('normalizeSynthesis defaults unknown decision to discard', () => {
  const result = normalizeSynthesis(
    { summary: 'x', salience: 0.9, decision: 'explode' as never },
    cfg,
  );
  assert.equal(result.decision, 'discard');
});

test('normalizeSynthesis truncates oversized memory and skill bodies', () => {
  const longText = 'x'.repeat(4000);
  const result = normalizeSynthesis(
    {
      summary: 's',
      salience: 0.9,
      decision: 'memorize',
      memory: { kind: 'conversation_crystal', text: longText, tags: [] },
    },
    cfg,
  );
  assert.equal(result.decision, 'memorize');
  assert.ok((result.memory?.text.length ?? 0) <= cfg.maxMemoryChars);
});

// ── runCrystallize orchestrator ──

test('runCrystallize skips when turn_count below threshold', async () => {
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 3,
        last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => { throw new Error('should not mark'); },
      addMemory: async () => { throw new Error('should not addMemory'); },
      addUserSkill: async () => { throw new Error('should not addSkill'); },
      logFeedback: async () => { throw new Error('should not log'); },
      collectTurns: async () => [],
      runEvaluator: async () => ({}),
    },
  );
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? '', /below threshold/);
});

test('runCrystallize skips when cooldown is active', async () => {
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 20,
        last_crystallized_at: new Date(Date.now() - 60_000).toISOString(),
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => { throw new Error('should not mark'); },
      addMemory: async () => { throw new Error('should not addMemory'); },
      addUserSkill: async () => { throw new Error('should not addSkill'); },
      logFeedback: async () => { throw new Error('should not log'); },
      collectTurns: async () => [],
      runEvaluator: async () => ({}),
    },
  );
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? '', /cooldown/);
});

test('runCrystallize memorizes when evaluator returns memorize decision', async () => {
  const turns: CrystallizeTurn[] = [
    {
      sessionKey: 'agent:main:proactive-ai:chat:a',
      userText: 'I live in Shanghai and prefer async communication'.padEnd(300, '.'),
      assistantText: 'Got it.',
      timestamp: null,
    },
  ];
  const addMemoryCalls: Array<{ kind: string; text: string }> = [];
  const logFeedbackCalls: Array<Record<string, unknown>> = [];
  let marked = false;
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 10,
        last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => { marked = true; },
      addMemory: async (input) => {
        addMemoryCalls.push({ kind: input.kind, text: input.text });
        return { id: 'm1', user_id: 'local', kind: input.kind, text: input.text, tags: input.tags ?? [], created_at: 'ts' };
      },
      addUserSkill: async () => { throw new Error('should not addSkill'); },
      logFeedback: async (payload) => { logFeedbackCalls.push(payload as Record<string, unknown>); return {} as never; },
      collectTurns: async () => turns,
      runEvaluator: async () => ({
        summary: 'user shared location and communication preference',
        salience: 0.8,
        decision: 'memorize',
        memory: {
          kind: 'conversation_crystal',
          text: 'User lives in Shanghai and prefers async communication.',
          tags: ['location', 'work'],
        },
      }),
    },
  );
  assert.equal(marked, true, 'markCrystallized must run before subagent');
  assert.equal(result.skipped, false);
  assert.equal(result.decision, 'memorize');
  assert.equal(result.memoryId, 'm1');
  assert.equal(addMemoryCalls.length, 1);
  assert.equal(logFeedbackCalls.length, 1);
  const logged = logFeedbackCalls[0] as { metadata: Record<string, unknown> };
  assert.equal(logged.metadata.decision, 'memorize');
});

test('runCrystallize creates skill and pointer memory on create_skill', async () => {
  const turns: CrystallizeTurn[] = [
    {
      sessionKey: 'agent:main:proactive-ai:chat:a',
      userText: 'When I ask about pricing always respond with a structured table'.padEnd(300, '.'),
      assistantText: 'Understood.',
      timestamp: null,
    },
  ];
  const skillCalls: Array<Record<string, unknown>> = [];
  const memoryCalls: Array<Record<string, unknown>> = [];
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 10,
        last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => undefined,
      addMemory: async (input) => {
        memoryCalls.push(input as Record<string, unknown>);
        return { id: 'm2', user_id: 'local', kind: input.kind, text: input.text, tags: input.tags ?? [], created_at: 'ts' };
      },
      addUserSkill: async (input) => {
        skillCalls.push(input as Record<string, unknown>);
        return {
          id: 'sk1',
          title: input.title,
          body_md: input.body_md,
          triggers: input.triggers ?? [],
          source: input.source,
          status: input.status ?? 'active',
          source_summary: input.source_summary ?? null,
          created_at: 'ts',
          updated_at: 'ts',
        };
      },
      logFeedback: async () => ({}) as never,
      collectTurns: async () => turns,
      runEvaluator: async () => ({
        summary: 'user expects structured pricing responses',
        salience: 0.85,
        decision: 'create_skill',
        skill: {
          title: 'Respond to pricing questions with a table',
          triggers: ['when the user asks about pricing'],
          bodyMarkdown: '## When to use\nPricing questions.\n\n## How to respond\nUse a markdown table.',
        },
      }),
    },
  );
  assert.equal(result.decision, 'create_skill');
  assert.equal(result.skillId, 'sk1');
  assert.equal(skillCalls.length, 1);
  assert.equal((skillCalls[0] as { source: string }).source, 'crystallize');
  assert.equal((skillCalls[0] as { status: string }).status, 'active');
  assert.equal(memoryCalls.length, 1, 'pointer memory is created alongside the skill');
});

test('runCrystallize discards when evaluator throws', async () => {
  const turns: CrystallizeTurn[] = [
    {
      sessionKey: 'agent:main:proactive-ai:chat:a',
      userText: 'x'.repeat(500),
      assistantText: 'y',
      timestamp: null,
    },
  ];
  const logFeedbackCalls: Array<Record<string, unknown>> = [];
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 10,
        last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => undefined,
      addMemory: async () => { throw new Error('should not addMemory'); },
      addUserSkill: async () => { throw new Error('should not addSkill'); },
      logFeedback: async (payload) => { logFeedbackCalls.push(payload as Record<string, unknown>); return {} as never; },
      collectTurns: async () => turns,
      runEvaluator: async () => { throw new Error('boom'); },
    },
  );
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? '', /boom/);
  assert.equal(logFeedbackCalls.length, 1);
  const logged = logFeedbackCalls[0] as { metadata: Record<string, unknown> };
  assert.equal(logged.metadata.decision, 'discard');
});

test('runCrystallize skips when collected user text is too short', async () => {
  const result = await runCrystallize(
    makeApi(),
    undefined,
    {
      getCrystallizeState: async () => ({
        turn_count: 10,
        last_crystallized_at: null,
        last_session_key: 'agent:main:proactive-ai:chat:a',
        last_message_at: null,
        updated_at: new Date().toISOString(),
      }),
      markCrystallized: async () => undefined,
      addMemory: async () => { throw new Error('should not addMemory'); },
      addUserSkill: async () => { throw new Error('should not addSkill'); },
      logFeedback: async () => ({}) as never,
      collectTurns: async () => [
        {
          sessionKey: 'agent:main:proactive-ai:chat:a',
          userText: 'hi',
          assistantText: 'hello',
          timestamp: null,
        },
      ],
      runEvaluator: async () => { throw new Error('evaluator must not run'); },
    },
  );
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? '', /minUserChars/);
});
