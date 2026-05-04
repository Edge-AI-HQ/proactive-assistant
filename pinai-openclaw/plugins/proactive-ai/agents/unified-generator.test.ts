import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUnifiedGeneratorPrompt,
  isUnifiedGeneratorCompleteOutput,
} from "./unified-generator.ts";

test("buildUnifiedGeneratorPrompt includes all 4 phases", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /phase_1_context_gathering/);
  assert.match(prompt, /phase_2_plan/);
  assert.match(prompt, /phase_3_generate/);
  assert.match(prompt, /phase_4_self_review/);
});

test("buildUnifiedGeneratorPrompt includes CLI guide and v3 retrieval commands", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  // The pin CLI command guide block is still injected
  assert.match(prompt, /pin_cli_command_guide/);
  assert.match(prompt, /获取数据层/);
  assert.match(prompt, /执行层/);
  assert.match(prompt, /World 流/);
  assert.match(prompt, /Gmail 执行样例/);

  // v3 retrieval commands replace the legacy 12-call list
  assert.match(prompt, /pin profile get/);
  assert.match(prompt, /pin memory list --minQuality 0\.7 --limit 30/);
  assert.match(prompt, /pin profile snapshot/);
  assert.match(prompt, /pin signals recent --status open --limit 30/);
  assert.match(prompt, /pin raw gmail recent/);
  assert.match(prompt, /pin raw gcal today/);
  assert.match(prompt, /pin raw device-apps --top 20/);
  assert.match(prompt, /pin world shortlist/);
  assert.match(prompt, /pin feedback list --limit 50/);
  assert.match(prompt, /they're recency-bounded/);
  assert.match(prompt, /pin cards recent --limit 10/);
  assert.doesNotMatch(prompt, /pin evolution recent/);
  assert.doesNotMatch(prompt, /pin skills list/);
  assert.doesNotMatch(prompt, /pin signals consume/);
  assert.match(prompt, /Direct `pin personal exec` is a\s+controlled fallback/i);
  assert.match(prompt, /GMAIL_CREATE_EMAIL_DRAFT/);
  assert.match(prompt, /GMAIL_SEND_DRAFT/);
  assert.match(prompt, /GMAIL_SEND_EMAIL[\s\S]*(继续禁止|draft|DRAFT)/);
  assert.doesNotMatch(prompt, /smiletoye@gmail\.com|PIN test|controlled PCI test/i);
  assert.match(prompt, /connector\.init \/ connector\.sync/);
});

test("buildUnifiedGeneratorPrompt includes scoring rubric", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /Relevance/);
  assert.match(prompt, /Actionability/);
  assert.match(prompt, /Why Now Clarity/i);
  assert.match(prompt, /Novelty/);
  assert.match(prompt, /Decision Compression/i);
  assert.match(prompt, /overall >= 5\.0/);
});

test("buildUnifiedGeneratorPrompt injects feedback and recent card history", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
    recentFeedbackSummary: "- Frequently confirmed: work cards (3)",
    recentGeneratedCardsSummary: "- work: sync-talking-points | 2026-04-14 | Sync talking points",
  });

  assert.match(prompt, /Recent User Feedback Signals/);
  assert.match(prompt, /Frequently confirmed: work cards/);
  assert.match(prompt, /Recent Generated Card History/);
  assert.match(prompt, /sync-talking-points/);
  assert.match(prompt, /advance/);
  assert.match(prompt, /refine/);
  assert.match(prompt, /suppress/);
});

test("buildUnifiedGeneratorPrompt omits empty feedback and card history sections", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.doesNotMatch(prompt, /Recent User Feedback Signals/);
  assert.doesNotMatch(prompt, /Recent Generated Card History/);
});

test("buildUnifiedGeneratorPrompt output format includes evaluations and batchFeedback", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /"evaluations"/);
  assert.match(prompt, /"batchFeedback"/);
  assert.match(prompt, /"cards"/);
  assert.match(prompt, /unified-generator/);
});

test("buildUnifiedGeneratorPrompt includes v3 personal_signals + raw layer guidance", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  // v3 layered context: long-term + right-now + behavior history + on-demand
  assert.match(prompt, /Long-term picture/);
  assert.match(prompt, /Right-now context/);
  assert.match(prompt, /待消化/);                                // Chinese label for待消化
  assert.match(prompt, /Behavior history/);
  assert.match(prompt, /On-demand deep dives/);

  // The agent is told signals + memory together form the strongest case
  assert.match(prompt, /personal_signal/);
  assert.match(prompt, /high-quality memory/);
});

test("buildUnifiedGeneratorPrompt prefers fresh raw connector reads over stale connector errors", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /Current raw commands are the freshest truth/);
  assert.match(prompt, /COMPOSIO_API_KEY/);
  assert.match(prompt, /pin raw gmail recent/);
  assert.match(prompt, /pin raw gcal today/);
  assert.match(prompt, /Home/);
});

// ── isUnifiedGeneratorCompleteOutput ──
//
// Predicate is consulted by collectAgentText to decide whether a session
// jsonl read represents a completed final turn vs a streaming intermediate.
// Tests cover: positive, the closing-fence guard, schema-shape rejections,
// and the jsonrepair-tolerant CJK-quote case (regression: strict parse
// would have rejected real completions on dev; see agent-runner notes).

const MINIMAL_VALID_OUTPUT = '```json\n{\n  "cards": [\n    { "title": "Review Brex card limit", "goalBasket": "work" }\n  ],\n  "evaluations": []\n}\n```';

test("isUnifiedGeneratorCompleteOutput accepts a complete fenced output", () => {
  assert.equal(isUnifiedGeneratorCompleteOutput(MINIMAL_VALID_OUTPUT), true);
});

test("isUnifiedGeneratorCompleteOutput rejects empty / undefined text", () => {
  assert.equal(isUnifiedGeneratorCompleteOutput(""), false);
});

test("isUnifiedGeneratorCompleteOutput rejects an unclosed json fence (mid-stream)", () => {
  // No trailing ``` — looks like agent is still writing the body.
  const partial = '```json\n{\n  "cards": [\n    { "title": "Review Brex card limit", "goalBasket": "work" }\n  ],\n  "evaluations": []';
  assert.equal(isUnifiedGeneratorCompleteOutput(partial), false);
});

test("isUnifiedGeneratorCompleteOutput rejects when cards is missing", () => {
  const noCards = '```json\n{\n  "evaluations": []\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(noCards), false);
});

test("isUnifiedGeneratorCompleteOutput accepts empty cards array (agent declined to generate)", () => {
  // The agent legitimately decides to generate nothing — e.g., new user with
  // no connectors, or genericness filter rejected all candidates. Caller
  // (finalizePipelineRun) treats this as a successful completion with
  // batchFeedback explaining why; the predicate must NOT reject it as
  // "still running" or the run will be retried until max_attempts.
  const declined = '```json\n{\n  "reasoning": "no usable signals",\n  "cards": [],\n  "evaluations": [],\n  "batchFeedback": "User has no connected toolkits yet."\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(declined), true);
});

test("isUnifiedGeneratorCompleteOutput rejects when any card lacks a non-empty title", () => {
  const blankTitle = '```json\n{\n  "cards": [\n    { "title": "", "goalBasket": "work" }\n  ],\n  "evaluations": []\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(blankTitle), false);
  const missingTitle = '```json\n{\n  "cards": [\n    { "goalBasket": "work" }\n  ],\n  "evaluations": []\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(missingTitle), false);
});

test("isUnifiedGeneratorCompleteOutput rejects when evaluations is not an array", () => {
  const noEvals = '```json\n{\n  "cards": [\n    { "title": "T", "goalBasket": "work" }\n  ]\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(noEvals), false);
});

test("isUnifiedGeneratorCompleteOutput accepts CJK-quoted strings via jsonrepair tolerance", () => {
  // LLMs frequently emit unescaped " inside CJK strings. parseAgentJson uses
  // jsonrepair to fix this — the predicate must accept it, otherwise real
  // completions would be flagged as intermediate.
  const cjkUnescaped = '```json\n{\n  "cards": [\n    { "title": "现在是从"关注"转向"实际体验"的最佳时机", "goalBasket": "work" }\n  ],\n  "evaluations": []\n}\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(cjkUnescaped), true);
});

test("isUnifiedGeneratorCompleteOutput rejects a structurally-broken body even if fence closes", () => {
  // Closing fence present, but body is truncated mid-string → parse fails
  // (jsonrepair can't recover this).
  const broken = '```json\n{\n  "cards": [\n    { "title": "abc\n```';
  assert.equal(isUnifiedGeneratorCompleteOutput(broken), false);
});
