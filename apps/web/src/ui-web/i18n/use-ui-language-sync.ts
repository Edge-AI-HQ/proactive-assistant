import { useEffect } from "react";
import { useUserSettings } from "@pin-ai/state";

import { loadAndSwitchLanguage } from "./index";

/**
 * Drives the shared UI language from the user's saved setting.
 *
 * Both web-medium apps (mobile `proactive-ai-frontend` + `apps/web`) call
 * this once near their root. It reads the shared TanStack Query cache via
 * `useUserSettings()` (no userKey → cache-follow only, the app's root
 * instance owns the `/settings` fetch) and re-applies the language whenever
 * `generationLanguage` changes — including a cross-device edit landing in
 * the cache. The same setting drives card/agent output language on the
 * backend (lang_clause); this is its UI half.
 */
export function useUiLanguageSync(): void {
  const { settings } = useUserSettings();
  const lang = settings?.generationLanguage;
  useEffect(() => {
    if (lang) void loadAndSwitchLanguage(lang);
  }, [lang]);
}
