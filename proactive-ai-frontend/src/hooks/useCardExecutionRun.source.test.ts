import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("useCardExecutionRun card context + feedback wiring", () => {
  test("card-thread turns ride the conversation pipeline with cardContext", () => {
    const source = readFileSync(join(__dirname, "useCardExecutionRun.ts"), "utf8");

    // Turns go through the unified conversation client with the card
    // payload as a FIELD (backend injects <card_context> on the thread's
    // first turn) — NOT embedded in the message text. The legacy
    // text-wrapping path must stay gone.
    expect(source).toContain("conversationSend(session, trimmed, { cardContext })");
    expect(source).not.toContain("buildRequestUserText");
    expect(source).not.toContain("/chat-stream");

    // History reads come from the conversation page (active/awaiting drive
    // the in-flight status), and legacy wrapped rows still strip on read.
    expect(source).toContain("conversationHistory(session, { limit: 200 })");
    expect(source).toContain("stripRequestOnlyCardContext");

    // Free-text replies double as card feedback.
    expect(source).toContain("buildCardThreadTextFeedbackBody");
    expect(source).toContain('proxyPost("/feedback"');
  });
});
