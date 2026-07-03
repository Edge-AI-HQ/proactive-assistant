import { describe, expect, test } from "vitest";

import { cleanAmbientTranscriptText } from "./ambient-transcript-clean";

describe("cleanAmbientTranscriptText", () => {
  test("keeps meaningful English speech and normalizes whitespace", () => {
    expect(cleanAmbientTranscriptText("  let's   ship the release tomorrow  "))
      .toBe("let's ship the release tomorrow");
  });

  test("keeps short Chinese replies (>= 2 CJK chars)", () => {
    expect(cleanAmbientTranscriptText("好的")).toBe("好的");
    expect(cleanAmbientTranscriptText("什么时候开会")).toBe("什么时候开会");
  });

  test("drops meaningless filler-only bursts", () => {
    expect(cleanAmbientTranscriptText("um, uh...")).toBeNull();
    expect(cleanAmbientTranscriptText("Hmm.")).toBeNull();
    expect(cleanAmbientTranscriptText("....")).toBeNull();
    expect(cleanAmbientTranscriptText("")).toBeNull();
  });

  test("strips leading/trailing filler words and boundary punctuation", () => {
    expect(cleanAmbientTranscriptText("Okay, meeting moved to Friday afternoon, yeah."))
      .toBe("meeting moved to Friday afternoon");
  });

  test("strips subtitle hallucinations at the boundaries", () => {
    expect(cleanAmbientTranscriptText("Thanks for watching! We need the invoice sent today"))
      .toBe("We need the invoice sent today");
    // Trailing hallucination is stripped together with an adjacent trailing
    // filler word (same pass as the dev implementation).
    expect(cleanAmbientTranscriptText("We need the invoice sent today yeah. Thanks for watching."))
      .toBe("We need the invoice sent today");
  });

  test("keeps single meaningful word plus a digit", () => {
    expect(cleanAmbientTranscriptText("gate 42")).toBe("gate 42");
  });

  test("drops low-information stopword-only text", () => {
    expect(cleanAmbientTranscriptText("the and of it")).toBeNull();
  });
});
