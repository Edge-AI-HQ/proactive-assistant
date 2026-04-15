import test from "node:test";
import assert from "node:assert/strict";

import { buildPlannerPrompt } from "./planner.ts";

test("buildPlannerPrompt injects feedback and recent generated card history", () => {
  const prompt = buildPlannerPrompt({
    currentDate: "2026-04-07",
    iterationNumber: 1,
    recentFeedbackSummary: "- Frequently confirmed: work cards (2)\n- Recent text preferences: Prefer morning work briefings",
    recentGeneratedCardsSummary: "- work: review-queue-with-alex | 2026-04-07 | Review queue with Alex",
  });

  assert.match(prompt, /Recent Generated Card History/);
  assert.match(prompt, /pin cards recent --limit 10 --json/);
  assert.match(prompt, /review-queue-with-alex/);
  assert.match(prompt, /sustained card-chat engagement/i);
  assert.match(prompt, /do not simply repeat the same card/i);
});

test("buildPlannerPrompt omits recent generated card section when empty", () => {
  const prompt = buildPlannerPrompt({
    currentDate: "2026-04-07",
    iterationNumber: 1,
  });

  assert.doesNotMatch(prompt, /Recent Generated Card History/);
});
