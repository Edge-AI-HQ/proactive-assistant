/**
 * UI 语言匹配 —— 纯逻辑（BCP-47 tag → 8 种支持语言），web 与 RN 共用。
 * 从 ui-web/src/i18n/languages.ts 上移（RN i18n 也要用；ui-web 侧 re-export
 * 保旧路径）。detectDeviceLanguage 留各端实现（web=navigator、RN=iOS
 * SettingsManager），介质各异不上移。
 */
import {
  GENERATION_LANGUAGE_OPTIONS,
  type SupportedGenerationLanguage,
} from "./intent-card";

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
