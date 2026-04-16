import test from "node:test";
import assert from "node:assert/strict";

import { buildGeneratorPrompt } from "./generator.ts";

test("buildGeneratorPrompt injects recent generated cards and follow-up guidance", () => {
  const prompt = buildGeneratorPrompt({
    currentDate: "2026-04-07",
    iterationNumber: 1,
    plan: JSON.stringify({ intentsToGenerate: [] }),
    recentFeedbackSummary: "- Frequently modified: health cards (1)\n- Recent text preferences: Prefer concise health nudges",
    recentGeneratedCardsSummary: "- health: adjust-evening-walk-plan | 2026-04-06 | Adjust evening walk plan",
  });

  assert.match(prompt, /Recent Generated Card History/);
  assert.match(prompt, /pin cards recent --limit 10 --json/);
  assert.match(prompt, /adjust-evening-walk-plan/);
  assert.match(prompt, /sustained card-chat engagement/i);
  assert.match(prompt, /do not simply restate the same card/i);
  assert.match(prompt, /next-stage card/i);
  assert.match(prompt, /avoid near-duplicate cards/i);
});

test("buildGeneratorPrompt omits recent generated card section when empty", () => {
  const prompt = buildGeneratorPrompt({
    currentDate: "2026-04-07",
    iterationNumber: 1,
    plan: JSON.stringify({ intentsToGenerate: [] }),
  });

  assert.doesNotMatch(prompt, /Recent Generated Card History/);
});
