import { describe, expect, test } from "vitest";

import { normalizeVoiceLanguage } from "./language";

describe("normalizeVoiceLanguage", () => {
  test("uses mixed Chinese-English mode when no user preference is available", () => {
    expect(normalizeVoiceLanguage(null)).toEqual({ browser: "zh-CN" });
    expect(normalizeVoiceLanguage("auto")).toEqual({ browser: "zh-CN" });
  });

  test("uses the saved generation language as the transcription hint", () => {
    expect(normalizeVoiceLanguage("zh-Hans")).toEqual({ openai: "zh", browser: "zh-CN" });
    expect(normalizeVoiceLanguage("ja")).toEqual({ openai: "ja", browser: "ja-JP" });
    expect(normalizeVoiceLanguage("en-US")).toEqual({ openai: "en", browser: "en-US" });
  });
});
