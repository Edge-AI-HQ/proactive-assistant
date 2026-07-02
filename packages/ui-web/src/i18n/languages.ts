import {
  matchSupportedLanguage,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";

// 纯逻辑（tag 匹配）已上移 @pin-ai/core（RN i18n 共用）；这里 re-export 保旧路径。
export { SUPPORTED_UI_LANGUAGES, matchSupportedLanguage } from "@pin-ai/core";

/** 首启/未登录时的 UI 语言:跟设备。 */
export function detectDeviceLanguage(): SupportedGenerationLanguage {
  return matchSupportedLanguage(
    typeof navigator !== "undefined" ? navigator.language : "",
  );
}
