import { useEffect } from "react";
import { useUserSettings } from "@pin-ai/state";

import { loadAndSwitchLanguage } from "./index";

/**
 * Drives the UI language from the user's saved setting —— web
 * `ui-web/src/i18n/use-ui-language-sync.ts` 的 RN 对应物（逐字同构）。
 * 读共享 TQ cache（无 userKey → 只跟 cache，root 的 useUserSettings(user.id)
 * 实例拥有 /settings fetch），generationLanguage 变化即切 UI 语言——包括
 * 跨设备改动落进 cache 的情况。同一设置同时驱动后端卡片/agent 输出语言
 * （lang_clause）；这里是它的 UI 半边。
 */
export function useUiLanguageSync(): void {
  const { settings } = useUserSettings();
  const lang = settings?.generationLanguage;
  useEffect(() => {
    if (lang) void loadAndSwitchLanguage(lang);
  }, [lang]);
}
