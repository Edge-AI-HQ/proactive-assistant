import { describe, expect, test } from "vitest";

import { normalizeVoiceLanguage } from "./voice-language";

describe("normalizeVoiceLanguage", () => {
  test("does not force English when no user preference is available", () => {
    expect(normalizeVoiceLanguage(null)).toEqual({ openai: "zh", browser: "zh-CN" });
    expect(normalizeVoiceLanguage("auto")).toEqual({ openai: "zh", browser: "zh-CN" });
  });

  test("uses the saved generation language as the transcription hint", () => {
    expect(normalizeVoiceLanguage("zh-Hans")).toEqual({ openai: "zh", browser: "zh-CN" });
    expect(normalizeVoiceLanguage("ja")).toEqual({ openai: "ja", browser: "ja-JP" });
    expect(normalizeVoiceLanguage("en-US")).toEqual({ openai: "en", browser: "en-US" });
  });

  test.each([
    ["en", { openai: "en", browser: "en-US" }],
    ["zh-Hans", { openai: "zh", browser: "zh-CN" }],
    ["ja", { openai: "ja", browser: "ja-JP" }],
    ["ko", { openai: "ko", browser: "ko-KR" }],
    ["es", { openai: "es", browser: "es-ES" }],
    ["fr", { openai: "fr", browser: "fr-FR" }],
    ["de", { openai: "de", browser: "de-DE" }],
    ["pt", { openai: "pt", browser: "pt-PT" }],
  ])("maps %s to native and cloud transcription hints", (language, expected) => {
    expect(normalizeVoiceLanguage(language)).toEqual(expected);
  });
});
