import { useCallback, useEffect, useRef, useState } from "react";
import { profileClientHintHeaders, proxyFetch, proxyPost } from "@/lib/api";
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
  /** Proactive heartbeat cadence in seconds — one of 30/60/300/1800. The
   * server mirrors it into the per-user proactive.tick task's interval. */
  proactiveIntervalSeconds: number;
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

// Bootstrap resilience: `/settings` is the one request that gates the
// whole UI (App.tsx shows a spinner until it lands). A single hung or
// dropped request — common on native right after the OAuth browser
// round-trip — used to strand the app on an unbounded spinner. So each
// attempt gets a hard timeout and transient failures retry with backoff.
const SETTINGS_TIMEOUT_MS = 12_000;
const SETTINGS_RETRY_DELAYS_MS = [500, 1500, 3000];

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
export function useUserSettings(
  // Gate the bootstrap fetch on an authenticated user. App passes the
  // signed-in user id (null while logged out). On native the Supabase
  // session only lands after the PKCE deep-link exchange resolves — after
  // this hook has already mounted — so firing `/settings` at mount would
  // reach the backend with no bearer and 401. A 401 is a 4xx, which
  // `refetch` treats as non-retryable (break), leaving settings=null /
  // loading=false; since nothing re-fetches on sign-in, that stale failure
  // surfaced as App.tsx's BootstrapError ("Couldn't reach the server")
  // until the user manually hit Retry. Keying the fetch on the user id
  // flips null→id only once a session exists, so the first `/settings`
  // carries a token. Consumers inside the authenticated tree omit this
  // (default null): App's instance has already populated `settingsCache`,
  // and they read it via the module cache + listener below.
  userKey: string | null = null,
): UseUserSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(() => settingsCache);
  const [loading, setLoading] = useState(settingsCache === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    let lastError: unknown = null;
    // attempt 0 is the initial try; the rest are backoff retries.
    for (let attempt = 0; attempt <= SETTINGS_RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, SETTINGS_RETRY_DELAYS_MS[attempt - 1]));
        if (!mountedRef.current) return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);
      try {
        const res = await proxyFetch("/settings", {
          headers: profileClientHintHeaders(),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json() as UserSettings;
          if (!mountedRef.current) return;
          publishSettings(data);
          setError(null);
          setLoading(false);
          return;
        }
        lastError = new Error(`/settings ${res.status}`);
        // 4xx (incl. a 401 that already survived proxyFetch's token-refresh
        // retry) won't recover by retrying — surface it and stop.
        if (res.status >= 400 && res.status < 500) break;
        // 5xx falls through to the backoff retry.
      } catch (err) {
        // Network error or timeout (AbortController) — transient, retry.
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!mountedRef.current) return;
    setError(lastError instanceof Error ? lastError.message : "Failed to load settings");
    setLoading(false);
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
      // Cache already warm (App fetched it post-login) — sync from it even
      // for consumers that pass no userKey; they only follow, never fetch.
      listener(settingsCache);
    } else if (userKey !== null) {
      // Authenticated and no cache yet — this is the one instance that owns
      // the bootstrap fetch. Re-runs when userKey flips null→id at sign-in.
      void refetch();
    }
    return () => {
      mountedRef.current = false;
      settingsListeners.delete(listener);
    };
  }, [refetch, userKey]);

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
