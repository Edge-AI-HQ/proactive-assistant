import {
  GENERATION_LANGUAGE_OPTIONS,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";

export const SUPPORTED_UI_LANGUAGES: readonly SupportedGenerationLanguage[] =
  GENERATION_LANGUAGE_OPTIONS.map((o) => o.value);

/** BCP-47 tag → 8 种支持语言之一;匹配不到回落 en。 */
export function matchSupportedLanguage(tag: string): SupportedGenerationLanguage {
  const lower = (tag || "").toLowerCase();
  // 产品只有简中:zh-CN/zh-TW/zh-Hant 全部归 zh-Hans(比回落英文更近)
  if (lower.startsWith("zh")) return "zh-Hans";
  const base = lower.split("-")[0];
  const hit = SUPPORTED_UI_LANGUAGES.find((l) => l.toLowerCase() === base);
  return hit ?? "en";
}

/** 首启/未登录时的 UI 语言:跟设备。 */
export function detectDeviceLanguage(): SupportedGenerationLanguage {
  return matchSupportedLanguage(
    typeof navigator !== "undefined" ? navigator.language : "",
  );
}
