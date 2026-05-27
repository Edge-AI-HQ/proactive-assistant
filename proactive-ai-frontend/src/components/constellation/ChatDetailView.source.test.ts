import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("ChatDetailView steer feedback entry", () => {
  test("keeps voice as a manual reply control", () => {
    const source = readFileSync(join(__dirname, "ChatDetailView.tsx"), "utf8");

    expect(source).not.toContain("autoStartVoice");
    expect(source).not.toContain("startCapture({");
    expect(source).toContain("<VoiceButton prefill={inputValue} onUpdate={setInputValue} />");
  });
});
