import { describe, expect, test } from "vitest";

import { normalizeVoiceLanguage } from "./language";

describe("normalizeVoiceLanguage", () => {
  test("uses English when no user preference is available", () => {
    expect(normalizeVoiceLanguage(null)).toEqual({ openai: "en", browser: "en-US" });
    expect(normalizeVoiceLanguage("auto")).toEqual({ openai: "en", browser: "en-US" });
  });

  test("uses the saved generation language as the transcription hint", () => {
    expect(normalizeVoiceLanguage("zh-Hans")).toEqual({ openai: "zh", browser: "zh-CN" });
    expect(normalizeVoiceLanguage("ja")).toEqual({ openai: "ja", browser: "ja-JP" });
    expect(normalizeVoiceLanguage("en-US")).toEqual({ openai: "en", browser: "en-US" });
  });
});
