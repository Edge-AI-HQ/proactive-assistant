// 源码断言测试（迁移自 proactive-ai-frontend hooks/useCardExecutionRun.source.test.ts，
// Phase 3 拆分后按文件归属重新分配断言）：锁定 card-thread 走统一 conversation
// pipeline 的调用形状，防止 legacy text-wrapping 路径回潮。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("card execution conversation wiring", () => {
  test("hook: card-thread turns ride the conversation pipeline with cardContext", () => {
    const source = readFileSync(join(__dirname, "card-execution.ts"), "utf8");

    // Turns go through the unified conversation client with the card
    // payload as a FIELD (backend injects <card_context> on the thread's
    // first turn) — NOT embedded in the message text. The legacy
    // text-wrapping path must stay gone.
    expect(source).toContain("conversationSend(session, trimmed, { cardContext })");
    expect(source).not.toContain("buildRequestUserText");
    expect(source).not.toContain("/chat-stream");

    // History reads come from the conversation page (active/awaiting drive
    // the in-flight status).
    expect(source).toContain("conversationHistory(session, { limit: 200 })");

    // Free-text replies double as card feedback.
    expect(source).toContain("buildCardThreadTextFeedbackBody");
    expect(source).toContain('proxyPost("/feedback"');
  });

  test("machine: legacy wrapped rows still strip on read", () => {
    const source = readFileSync(
      join(__dirname, "../../../core/src/machines/card-execution.ts"),
      "utf8",
    );
    expect(source).toContain("stripRequestOnlyCardContext");
  });
});
