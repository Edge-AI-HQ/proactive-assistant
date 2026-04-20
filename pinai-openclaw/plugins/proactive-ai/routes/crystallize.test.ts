import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { handleCrystallize } from './crystallize.ts';

function createRequest(method: string, body?: Record<string, unknown>) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(chunk?: string) {
      if (chunk) response.body += chunk;
      return response;
    },
  };
  return response;
}

function makeCtx(method: string, subpath: string, body?: Record<string, unknown>) {
  const res = createResponse();
  const req = createRequest(method, body);
  const url = new URL(`http://localhost${subpath}`);
  return {
    ctx: {
      subpath: url.pathname,
      req,
      res,
      url,
      api: {
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
      },
    } as never,
    res,
  };
}

const baseDeps = (overrides: Record<string, number> = {}) => ({
  getCrystallizeState: async () => ({
    turn_count: 7,
    last_crystallized_at: '2026-04-19T10:00:00.000Z',
    last_session_key: 'agent:main:proactive-ai:chat:abc',
    last_message_at: '2026-04-20T01:00:00.000Z',
    updated_at: '2026-04-20T01:00:00.000Z',
  }),
  getCrystallizeOverride: async () => overrides,
  setCrystallizeOverride: async (patch: Record<string, number | null>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete overrides[k];
      else overrides[k] = v;
    }
    return overrides;
  },
  listFeedback: async () => [],
  listUserSkills: async (opts?: { status?: 'active' | 'disabled' }) => {
    if (opts?.status === 'active') {
      return [{ id: 's1' }, { id: 's2' }] as never;
    }
    return [{ id: 's1' }, { id: 's2' }, { id: 's3' }] as never;
  },
  getUserSettings: async () => ({
    user_id: 'local',
    generation_language: 'en',
    auto_generate: true,
    auto_dreaming: false,
    auto_crystallize: true,
    metadata: {},
    updated_at: '2026-04-20T00:00:00.000Z',
  }),
  runCrystallize: async () => ({ skipped: false, decision: 'memorize' as const, salience: 0.8 }),
});

test('GET /crystallize/state returns state, defaults, override, effective and skill counts', async () => {
  const handler = handleCrystallize(baseDeps({ messageThreshold: 5 }) as never);
  const { ctx, res } = makeCtx('GET', '/crystallize/state');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.turn_count, 7);
  assert.equal(parsed.settings.auto_crystallize, true);
  assert.equal(parsed.config.defaults.messageThreshold, 10);
  assert.equal(parsed.config.override.messageThreshold, 5);
  assert.equal(parsed.config.effective.messageThreshold, 5);
  assert.equal(parsed.config.effective.cooldownMs, parsed.config.defaults.cooldownMs);
  assert.deepEqual(parsed.skillCounts, { active: 2, disabled: 1, total: 3 });
  assert.deepEqual(parsed.recentDecisions, []);
});

test('GET /crystallize/state filters recent decisions to conversation_crystal entries with summary truncation', async () => {
  const longText = 'x'.repeat(500);
  const deps = baseDeps();
  deps.listFeedback = async () => [
    {
      id: 'f1',
      user_id: 'local',
      kind: 'text_feedback',
      action: null,
      push_id: null,
      intent_card_id: null,
      intent_key: null,
      conversation_id: null,
      message_id: null,
      source: 'agent_analysis',
      basket: null,
      channel: 'web',
      value: null,
      text: longText,
      metadata: { analysisType: 'conversation_crystal', decision: 'memorize', salience: 0.7, memoryId: 'm1', turnCount: 10 },
      created_at: '2026-04-20T05:00:00.000Z',
    },
    {
      id: 'f2',
      user_id: 'local',
      kind: 'text_feedback',
      action: null, push_id: null, intent_card_id: null, intent_key: null, conversation_id: null, message_id: null,
      source: 'agent_analysis', basket: null, channel: 'web', value: null,
      text: 'card chat noise',
      metadata: { analysisType: 'card_chat_summary' },
      created_at: '2026-04-20T04:00:00.000Z',
    },
  ] as never;

  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('GET', '/crystallize/state');
  await handler(ctx);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.recentDecisions.length, 1);
  assert.equal(parsed.recentDecisions[0].decision, 'memorize');
  assert.equal(parsed.recentDecisions[0].memoryId, 'm1');
  assert.ok(parsed.recentDecisions[0].summary.length <= 200);
  assert.ok(parsed.recentDecisions[0].summary.endsWith('…'));
});

test('PATCH /crystallize/config persists tunable subset and returns full state', async () => {
  const overrides: Record<string, number> = {};
  const deps = baseDeps(overrides);
  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { messageThreshold: 5, salienceFloor: 0.4 });
  await handler(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(overrides, { messageThreshold: 5, salienceFloor: 0.4 });
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.config.override.messageThreshold, 5);
  assert.equal(parsed.config.override.salienceFloor, 0.4);
});

test('PATCH /crystallize/config { key: null } clears override', async () => {
  const overrides: Record<string, number> = { messageThreshold: 5 };
  const deps = baseDeps(overrides);
  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { messageThreshold: null });
  await handler(ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(overrides, {});
});

test('PATCH /crystallize/config rejects unknown key', async () => {
  const handler = handleCrystallize(baseDeps() as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { evilKey: 1 });
  await handler(ctx);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Unknown config key/);
});

test('PATCH /crystallize/config rejects out-of-bounds value', async () => {
  const handler = handleCrystallize(baseDeps() as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { messageThreshold: 9999 });
  await handler(ctx);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /must be in/);
});

test('PATCH /crystallize/config rejects non-integer for integer field', async () => {
  const handler = handleCrystallize(baseDeps() as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { messageThreshold: 5.5 });
  await handler(ctx);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /must be an integer/);
});

test('PATCH /crystallize/config accepts salienceFloor as float in [0,1]', async () => {
  const overrides: Record<string, number> = {};
  const deps = baseDeps(overrides);
  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('PATCH', '/crystallize/config', { salienceFloor: 0.55 });
  await handler(ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(overrides.salienceFloor, 0.55);
});

test('POST /crystallize/run returns runCrystallize result', async () => {
  const calls: Array<{ force?: boolean }> = [];
  const deps = baseDeps();
  deps.runCrystallize = async (_api: unknown, opts: { force?: boolean }) => {
    calls.push(opts);
    return { skipped: false, decision: 'create_skill' as const, salience: 0.85, skillId: 'sk_xyz' };
  };
  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('POST', '/crystallize/run');
  await handler(ctx);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.decision, 'create_skill');
  assert.equal(parsed.result.skillId, 'sk_xyz');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].force, true);
});

test('POST /crystallize/run returns 500 when runCrystallize throws', async () => {
  const deps = baseDeps();
  deps.runCrystallize = async () => { throw new Error('boom'); };
  const handler = handleCrystallize(deps as never);
  const { ctx, res } = makeCtx('POST', '/crystallize/run');
  await handler(ctx);
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /boom/);
});

test('handler returns false for unrelated subpaths', async () => {
  const handler = handleCrystallize(baseDeps() as never);
  const { ctx } = makeCtx('GET', '/skills');
  const handled = await handler(ctx);
  assert.equal(handled, false);
});
