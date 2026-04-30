/**
 * Regression tests for parseAgentJson — specifically the malformed-quote
 * cases that LLMs (especially with CJK output) hit in production.
 *
 * Real failure captured 2026-04-24 from a generation run:
 *   "whyNow": "现在是从"关注"转向"实际体验"的最佳时机"
 *                     ^^^^      ^^^^^^^^
 *                     unescaped ASCII " inside a string → JSON.parse throws
 *
 * After the jsonrepair fallback was added, parseAgentJson should recover
 * these cases instead of returning null and forcing the orchestrator to
 * discard the whole batch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAgentText,
  parseAgentJson,
  parseAgentJsonOrThrow,
} from './agent-runner.ts';

test('parseAgentJson: clean json fence parses normally', () => {
  const text = '```json\n{"cards": [{"title": "hello"}]}\n```';
  const out = parseAgentJson<{ cards: Array<{ title: string }> }>(text);
  assert.ok(out);
  assert.equal(out!.cards[0].title, 'hello');
});

test('parseAgentJson: unescaped " inside a Chinese string recovers via jsonrepair', () => {
  // The exact failure mode from prod: ASCII " around 关注 / 实际体验
  const text = '```json\n{"cards":[{"title":"SpaceX-Cursor","whyNow":"现在是从"关注"转向"实际体验"的最佳时机"}]}\n```';
  const out = parseAgentJson<{ cards: Array<{ title: string; whyNow: string }> }>(text);
  assert.ok(out, 'expected jsonrepair to recover the malformed JSON');
  assert.equal(out!.cards[0].title, 'SpaceX-Cursor');
  // jsonrepair preserves the inner quotes one way or another — we don't
  // care exactly how, just that the whyNow field exists and references
  // both nested terms.
  assert.match(out!.cards[0].whyNow, /关注/);
  assert.match(out!.cards[0].whyNow, /实际体验/);
});

test('parseAgentJson: trailing comma recovers via jsonrepair', () => {
  const text = '```json\n{"cards":[{"title":"a"},]}\n```';
  const out = parseAgentJson<{ cards: Array<{ title: string }> }>(text);
  assert.ok(out, 'expected jsonrepair to drop the trailing comma');
  assert.equal(out!.cards[0].title, 'a');
});

test('parseAgentJson: still returns null for genuinely unrecoverable input', () => {
  const out = parseAgentJson('this is just prose, no JSON at all');
  assert.equal(out, null);
});

test('parseAgentJson: empty input returns null', () => {
  assert.equal(parseAgentJson(''), null);
});

test('parseAgentJsonOrThrow: throws clear error when no JSON present', () => {
  assert.throws(
    () => parseAgentJsonOrThrow('just prose', 'test:1'),
    /Agent test:1 returned invalid JSON/,
  );
});

// ── collectAgentText: validateFinal fall-through behaviour ──
//
// Production observation 2026-04-30 (fly machine 48e619eb060d68, run
// `run_manual_mokzougs`) showed `waitForRun` returning timeout 20+ minutes
// after the agent had already written its final assistant turn to the
// session jsonl. validateFinal lets the caller use the session as the source
// of truth instead of trusting the wait signal blindly.

interface FakeWaitResult {
  status: 'ok' | 'timeout' | 'error';
  error?: string;
}

function makeApi(opts: {
  wait: FakeWaitResult;
  sessionMessages: Array<{ role: string; content: unknown; error?: string }>;
}): any {
  return {
    runtime: {
      subagent: {
        waitForRun: async () => opts.wait,
        getSessionMessages: async () => ({ messages: opts.sessionMessages }),
      },
    },
  };
}

const FINAL_ASSISTANT_TEXT = '```json\n{"cards":[{"title":"T","goalBasket":"work"}],"evaluations":[]}\n```';
const PARTIAL_ASSISTANT_TEXT = '```json\n{"cards":[{"title":"T","goalBasket":"work"}],"evaluations":[]'; // no closing fence

test('collectAgentText: legacy mode (no validateFinal) trusts waitForRun ok', async () => {
  const api = makeApi({
    wait: { status: 'ok' },
    sessionMessages: [{ role: 'assistant', content: FINAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, { runId: 'r', sessionKey: 's', timeoutMs: 100 });
  assert.equal(r.status, 'ok');
  assert.match(r.text!, /"cards"/);
});

test('collectAgentText: legacy mode returns timeout immediately on waitForRun timeout', async () => {
  // No validateFinal — preserves the old behaviour where timeout meant "stop here, retry later".
  const api = makeApi({
    wait: { status: 'timeout' },
    sessionMessages: [{ role: 'assistant', content: FINAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, { runId: 'r', sessionKey: 's', timeoutMs: 100 });
  assert.equal(r.status, 'timeout');
});

test('collectAgentText: with validateFinal, waitForRun timeout falls back to session and succeeds', async () => {
  // The mokzougs case — wait reports timeout but session has the final turn.
  const api = makeApi({
    wait: { status: 'timeout' },
    sessionMessages: [{ role: 'assistant', content: FINAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 100,
    validateFinal: (t) => /```json[\s\S]*```\s*$/.test(t),
  });
  assert.equal(r.status, 'ok');
});

test('collectAgentText: with validateFinal, waitForRun timeout + partial session returns timeout', async () => {
  // Agent really is mid-write — session content fails the predicate.
  const api = makeApi({
    wait: { status: 'timeout' },
    sessionMessages: [{ role: 'assistant', content: PARTIAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 100,
    validateFinal: (t) => /```json[\s\S]*```\s*$/.test(t),
  });
  assert.equal(r.status, 'timeout');
});

test('collectAgentText: with validateFinal, waitForRun ok still validates session content', async () => {
  // Even on ok we re-check the session — waitForRun ok has been observed to
  // race with the writer in tests; the session is canonical.
  const api = makeApi({
    wait: { status: 'ok' },
    sessionMessages: [{ role: 'assistant', content: PARTIAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 100,
    validateFinal: (t) => /```json[\s\S]*```\s*$/.test(t),
  });
  assert.equal(r.status, 'timeout');
});

test('collectAgentText: waitForRun error is terminal regardless of validator', async () => {
  const api = makeApi({
    wait: { status: 'error', error: 'subagent crashed' },
    sessionMessages: [{ role: 'assistant', content: FINAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 100,
    validateFinal: () => true,
  });
  assert.equal(r.status, 'error');
  assert.match(r.error!, /subagent crashed/);
});

test('collectAgentText: empty session under validateFinal yields timeout (still running)', async () => {
  const api = makeApi({
    wait: { status: 'timeout' },
    sessionMessages: [],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 100,
    validateFinal: () => true,
  });
  assert.equal(r.status, 'timeout');
});

test('collectAgentText: skipWait reads session directly and validates', async () => {
  const api = makeApi({
    // wait would never be called when skipWait=true
    wait: { status: 'error', error: 'should not be called' },
    sessionMessages: [{ role: 'assistant', content: FINAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 0,
    skipWait: true,
    validateFinal: (t) => /```json[\s\S]*```\s*$/.test(t),
  });
  assert.equal(r.status, 'ok');
});

test('collectAgentText: skipWait + partial session returns timeout (do not markFailed)', async () => {
  // Recovery path — agent died mid-write. Returning timeout instead of error
  // lets the caller (recoverStrandedPipelineRuns) markFailed with the right
  // reason rather than crashing through finalize parse.
  const api = makeApi({
    wait: { status: 'error', error: 'should not be called' },
    sessionMessages: [{ role: 'assistant', content: PARTIAL_ASSISTANT_TEXT }],
  });
  const r = await collectAgentText(api, {
    runId: 'r',
    sessionKey: 's',
    timeoutMs: 0,
    skipWait: true,
    validateFinal: (t) => /```json[\s\S]*```\s*$/.test(t),
  });
  assert.equal(r.status, 'timeout');
});

test('parseAgentJsonOrThrow: succeeds on the prod failure payload', () => {
  // This is structurally the same shape that failed in prod on 2026-04-24.
  const text = `Some preamble text the model emitted.

\`\`\`json
{
  "reasoning": "Context gathering: Profile is busy professional",
  "cards": [
    {
      "id": "card-1",
      "title": "SpaceX-Cursor收购后两天——今天用30分钟实际体验",
      "whyNow": "收购消息公布已过48小时，现在是从"关注"转向"实际体验"的最佳时机"
    }
  ]
}
\`\`\``;
  const out = parseAgentJsonOrThrow<{ reasoning: string; cards: Array<{ id: string; title: string; whyNow: string }> }>(text, 'generate');
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].id, 'card-1');
  assert.match(out.cards[0].whyNow, /关注/);
});
