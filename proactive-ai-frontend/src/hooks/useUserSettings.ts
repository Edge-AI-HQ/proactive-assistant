import { useCallback, useEffect, useRef, useState } from "react";
import { proxyFetch, proxyPost } from "@/lib/api";
import type { SupportedGenerationLanguage } from "@/types/intent-card";

/**
 * Per-mobile-source ambient capture consent. Empty map = no ambient
 * capture (privacy invariant per V3 migration plan D-5). Source keys
 * are slugs the @pin/capacitor-ambient-ai facade understands
 * (sound_classifier, visit, activity, location, …).
 */
export interface AmbientSourceConsent {
  enabled: boolean;
  updatedAt?: string | null;
}

// Mirrors backend `SettingsResponse` (camelCase via _CamelModel alias).
// Single source of truth for every user-settings toggle: language,
// auto-generate (+ interval), auto-dreaming, auto-crystallize, ambient
// capture consent.
export interface UserSettings {
  generationLanguage: SupportedGenerationLanguage;
  autoGenerate: boolean;
  autoGenerateIntervalMinutes: number;
  autoDreaming: boolean;
  autoCrystallize: boolean;
  metadata: Record<string, unknown>;
  ambientSources: Record<string, AmbientSourceConsent>;
  notifyNewCards: boolean;
  /** ISO timestamp the first time we showed the in-app pre-prompt; null
   * means the prompt has never been shown for this user. Used by the
   * home screen to decide whether to mount PreNotificationPrompt. */
  notifyPermissionPromptedAt: string | null;
  /** ISO timestamp the user finished or skipped through first-run
   * onboarding. null → App.tsx renders <OnboardingFlow />; non-null →
   * render the main shell. Monotonic — never returns to null. */
  onboardingCompletedAt: string | null;
  updatedAt: string;
}

/**
 * Partial settings patch. ``ambientSources`` is a per-key map; entries
 * with ``null`` value remove the key server-side (see profile.py
 * update_settings route).
 *
 * ``notifyPermissionPrompted`` is a write-only trigger: pass ``true`` to
 * stamp ``notifyPermissionPromptedAt = NOW()`` server-side. The server
 * never clears this column, so passing ``false``/omitting is a no-op.
 */
export type UserSettingsPatch = Partial<
  Omit<
    UserSettings,
    | "updatedAt"
    | "ambientSources"
    | "notifyPermissionPromptedAt"
    | "onboardingCompletedAt"
  >
> & {
  ambientSources?: Record<string, AmbientSourceConsent | null>;
  notifyPermissionPrompted?: boolean;
  /** Write-only trigger: pass `true` to stamp `onboardingCompletedAt =
   * NOW()` server-side. Server never clears the column, so passing
   * `false`/omitting is a no-op. */
  onboardingCompleted?: boolean;
};

export interface UseUserSettingsResult {
  settings: UserSettings | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** Apply a partial update; returns the new settings or null on failure. */
  patch: (next: UserSettingsPatch) => Promise<UserSettings | null>;
  refetch: () => Promise<void>;
}

let settingsCache: UserSettings | null = null;
const settingsListeners = new Set<(settings: UserSettings) => void>();

function publishSettings(settings: UserSettings): void {
  settingsCache = settings;
  settingsListeners.forEach((listener) => listener(settings));
}

/**
 * Read + patch the unified `/api/settings` resource.
 *
 * Caller passes only the fields it owns (e.g. AutoGenerateSettings sends
 * `autoGenerate` + `autoGenerateIntervalMinutes`). Server preserves any
 * field omitted from the body via COALESCE, so concurrent components
 * editing different fields don't clobber each other.
 *
 * The module cache keeps independent settings controls in sync. In
 * particular, Control Panel language edits must update App.tsx so Ambient
 * transcription uses the new language immediately.
 */
export function useUserSettings(): UseUserSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(() => settingsCache);
  const [loading, setLoading] = useState(settingsCache === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await proxyFetch("/settings");
      if (!res.ok) throw new Error(`/settings ${res.status}`);
      const data = await res.json() as UserSettings;
      if (!mountedRef.current) return;
      publishSettings(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load settings");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const listener = (next: UserSettings) => {
      if (!mountedRef.current) return;
      setSettings(next);
      setLoading(false);
      setError(null);
    };
    settingsListeners.add(listener);
    if (settingsCache) {
      listener(settingsCache);
    } else {
      void refetch();
    }
    return () => {
      mountedRef.current = false;
      settingsListeners.delete(listener);
    };
  }, [refetch]);

  const patch = useCallback(async (next: UserSettingsPatch): Promise<UserSettings | null> => {
    setSaving(true);
    setError(null);
    try {
      const res = await proxyPost("/settings", next);
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`/settings ${res.status} ${detail}`);
      }
      const data = await res.json() as UserSettings;
      publishSettings(data);
      return data;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to save settings");
      }
      return null;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, patch, refetch };
}
