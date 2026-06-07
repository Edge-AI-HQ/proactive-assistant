import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("ChatDetailView steer feedback entry", () => {
  test("never auto-starts voice capture", () => {
    // ChatDetailView now delegates its whole reply surface (including the
    // manual VoiceButton) to ConversationView, so the component file no
    // longer renders a VoiceButton directly. It must still never opt into
    // auto-started capture — voice stays a manual control.
    const source = readFileSync(join(__dirname, "ChatDetailView.tsx"), "utf8");

    expect(source).not.toContain("autoStartVoice");
    expect(source).not.toContain("startCapture({");
  });
});
