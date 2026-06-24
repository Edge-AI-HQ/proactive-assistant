import { describe, expect, test } from "vitest";

import { appendVoiceTranscript } from "./text";

describe("appendVoiceTranscript", () => {
  test("uses the transcript as the draft when the existing text is empty", () => {
    expect(appendVoiceTranscript("", "  hello there  ")).toBe("hello there");
  });

  test("inserts a space between existing prose and new transcript text", () => {
    expect(appendVoiceTranscript("Book the flight", "tomorrow")).toBe("Book the flight tomorrow");
  });

  test("does not add a space before punctuation", () => {
    expect(appendVoiceTranscript("Book the flight", ".")).toBe("Book the flight.");
  });
});
