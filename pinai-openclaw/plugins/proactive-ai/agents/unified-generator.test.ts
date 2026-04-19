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

test("buildUnifiedGeneratorPrompt includes CLI guide with --full hint", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /pin_cli_command_guide/);
  assert.match(prompt, /--full/);
  assert.match(prompt, /truncated/);
  assert.match(prompt, /pin personal mobile items list --status pending --limit 20 --json/);
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

test("buildUnifiedGeneratorPrompt includes mobile items in context gathering", () => {
  const prompt = buildUnifiedGeneratorPrompt({
    currentDate: "2026-04-15",
  });

  assert.match(prompt, /Mobile high-value context/);
  assert.match(prompt, /pin personal mobile items list --status pending --limit 20 --json/);
  assert.match(prompt, /attention_item/);
  assert.match(prompt, /session_summary/);
});
