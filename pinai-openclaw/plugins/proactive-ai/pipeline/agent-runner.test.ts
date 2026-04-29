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
import { parseAgentJson, parseAgentJsonOrThrow } from './agent-runner.ts';

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
