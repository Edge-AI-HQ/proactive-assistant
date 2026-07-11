import { describe, expect, test } from "vitest";

import { matchSupportedLanguage } from "./languages";

describe("matchSupportedLanguage", () => {
  test("精确命中", () => {
    expect(matchSupportedLanguage("ja")).toBe("ja");
    expect(matchSupportedLanguage("zh-Hans")).toBe("zh-Hans");
  });
  test("带地区码的 BCP-47 tag 取主语言", () => {
    expect(matchSupportedLanguage("ja-JP")).toBe("ja");
    expect(matchSupportedLanguage("pt-BR")).toBe("pt");
    expect(matchSupportedLanguage("de-AT")).toBe("de");
  });
  test("中文任何变体都归 zh-Hans(产品只有简中)", () => {
    expect(matchSupportedLanguage("zh-CN")).toBe("zh-Hans");
    expect(matchSupportedLanguage("zh-TW")).toBe("zh-Hans");
    expect(matchSupportedLanguage("zh")).toBe("zh-Hans");
  });
  test("不支持的语言回落 en", () => {
    expect(matchSupportedLanguage("ru-RU")).toBe("en");
    expect(matchSupportedLanguage("")).toBe("en");
  });
});
