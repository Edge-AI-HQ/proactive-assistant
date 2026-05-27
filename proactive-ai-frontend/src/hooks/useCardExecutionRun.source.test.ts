import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("useCardExecutionRun card feedback context", () => {
  test("sends current card context on card-thread turns", () => {
    const source = readFileSync(join(__dirname, "useCardExecutionRun.ts"), "utf8");

    expect(source).toContain("buildRequestUserText");
    expect(source).toContain("buildCardThreadTextFeedbackBody");
    expect(source).toContain("cardContext?: Record<string, unknown>");
    expect(source).toContain("cardContext");
    expect(source).toContain("requestMessage");
    expect(source).toContain('proxyPost("/feedback"');
  });
});
