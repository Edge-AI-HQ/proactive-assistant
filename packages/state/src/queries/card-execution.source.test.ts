// 源码断言测试（迁移自 proactive-ai-frontend hooks/useCardExecutionRun.source.test.ts）：
// 锁定 card-thread 复用统一 conversation runtime（与 main chat 同一个
// useConversationRuntime + SSE 数据通路）的调用形状，防止 legacy text-wrapping
// 或独立 poll 路径回潮。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("card execution conversation wiring", () => {
  test("hook: card-thread rides the shared conversation runtime, not a bespoke send/poll path", () => {
    const source = readFileSync(join(__dirname, "card-execution.ts"), "utf8");

    // Card detail consumes the SAME runtime main chat uses. cardContext is a
    // FIELD (backend injects <card_context> on the thread's first turn) — NOT
    // embedded in the message text — and there is no separate history poll.
    expect(source).toContain("useConversationRuntime({ session, cardContext, bootstrap, localHistory })");
    expect(source).toContain("runtime.sendMessage(trimmed)");
    expect(source).not.toContain("buildRequestUserText");
    expect(source).not.toContain("/chat-stream");

    // The drawer snapshot is a pure projection over the runtime transcript
    // (deriveRunSnapshot), not a history-page → snapshot reduction.
    expect(source).toContain("deriveRunSnapshot(session, runtime.transcript");

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
