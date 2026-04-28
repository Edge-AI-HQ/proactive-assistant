import test from "node:test";
import assert from "node:assert/strict";

import { buildUnifiedGeneratorPrompt } from "./unified-generator.ts";

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

  // v3 retrieval commands replace the legacy 12-call list
  assert.match(prompt, /pin profile get --id default --full/);
  assert.match(prompt, /pin memory list --minQuality 0\.7 --limit 30/);
  assert.match(prompt, /pin signals recent --status open --limit 30/);
  assert.match(prompt, /pin raw gmail recent/);
  assert.match(prompt, /pin raw gcal today/);
  assert.match(prompt, /pin raw device-apps --top 20/);
  assert.match(prompt, /pin world shortlist/);
  assert.match(prompt, /pin feedback list --limit 50/);
  assert.match(prompt, /they're recency-bounded/);
  assert.match(prompt, /pin cards recent --limit 10/);
  assert.match(prompt, /pin evolution recent --kind daily_dream/);
  assert.match(prompt, /pin skills list --status enabled/);
  assert.match(prompt, /direct Composio tool commands are disabled/);
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

test("buildUnifiedGeneratorPrompt output format includes evaluations and iterationFeedback", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /"evaluations"/);
  assert.match(prompt, /"iterationFeedback"/);
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
