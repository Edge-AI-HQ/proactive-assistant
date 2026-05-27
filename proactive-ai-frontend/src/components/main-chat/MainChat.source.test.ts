import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("MainChat card-feedback entry", () => {
  test("opens directly into the conversation view when card context is present", () => {
    const source = readFileSync(join(__dirname, "../MainChat.tsx"), "utf8");

    expect(source).toContain('useState<ViewMode>(cardContext ? "conversation" : "landing")');
    expect(source).toContain("Feedback on this card");
    expect(source).not.toContain("autoStartVoice");
  });
});
