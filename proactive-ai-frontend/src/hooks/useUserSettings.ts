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
  updatedAt: string;
}

/**
 * Partial settings patch. ``ambientSources`` is a per-key map; entries
 * with ``null`` value remove the key server-side (see profile.py
 * update_settings route).
 */
export type UserSettingsPatch = Partial<Omit<UserSettings, "updatedAt" | "ambientSources">> & {
  ambientSources?: Record<string, AmbientSourceConsent | null>;
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

/**
 * Read + patch the unified `/api/settings` resource.
 *
 * Caller passes only the fields it owns (e.g. AutoGenerateSettings sends
 * `autoGenerate` + `autoGenerateIntervalMinutes`). Server preserves any
 * field omitted from the body via COALESCE, so concurrent components
 * editing different fields don't clobber each other.
 *
 * No global cache: each component using this hook fetches once on mount.
 * The data is tiny and rarely-edited; SWR / React Query would be
 * over-engineering for one row of settings per user.
 */
export function useUserSettings(): UseUserSettingsResult {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
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
      setSettings(data);
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
    void refetch();
    return () => { mountedRef.current = false; };
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
      if (mountedRef.current) setSettings(data);
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
