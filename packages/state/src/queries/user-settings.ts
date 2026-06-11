import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getTransportConfig,
  proxyFetch,
  proxyPost,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";

export const userSettingsKeys = {
  all: ["user-settings"] as const,
};

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
// attempt gets a hard timeout and transient failures retry with backoff;
// definitive 4xx (incl. a 401 that already survived the transport's
// token-refresh retry) fails fast.
const SETTINGS_TIMEOUT_MS = 12_000;
const SETTINGS_RETRY_DELAYS_MS = [500, 1500, 3000];

class SettingsHttpError extends Error {
  constructor(public readonly status: number) {
    super(`/settings ${status}`);
    this.name = "SettingsHttpError";
  }
}

async function fetchSettings(outerSignal?: AbortSignal): Promise<UserSettings> {
  // 每次尝试 12s 硬超时，与 TQ 的取消信号组合。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onAbort);
  try {
    const res = await proxyFetch("/settings", {
      headers: getTransportConfig().clientHintHeaders?.() ?? {},
      signal: controller.signal,
    });
    if (!res.ok) throw new SettingsHttpError(res.status);
    return (await res.json()) as UserSettings;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onAbort);
  }
}

async function patchSettings(next: UserSettingsPatch): Promise<UserSettings> {
  const res = await proxyPost("/settings", next);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/settings ${res.status} ${detail}`);
  }
  return (await res.json()) as UserSettings;
}

/**
 * Read + patch the unified `/api/settings` resource.
 *
 * Caller passes only the fields it owns (e.g. AutoGenerateSettings sends
 * `autoGenerate` + `autoGenerateIntervalMinutes`). Server preserves any
 * field omitted from the body via COALESCE, so concurrent components
 * editing different fields don't clobber each other.
 *
 * 多实例同步：迁移前靠手撸 module cache + listener set；现在所有实例共享
 * TQ cache（同一 queryKey），patch 成功用响应 setQueryData，天然同步。
 * 特别地 Control Panel 的语言编辑会立即更新 App.tsx 的 Ambient 转写语言。
 */
export function useUserSettings(
  // Gate the bootstrap fetch on an authenticated user. App passes the
  // signed-in user id (null while logged out); on native the Supabase
  // session only lands after the PKCE deep-link exchange, so fetching at
  // mount would 401. Consumers inside the authenticated tree omit this
  // (default null): they never fetch, only follow the shared cache that
  // App's instance populated (enabled=false still reads cached data).
  userKey: string | null = null,
): UseUserSettingsResult {
  const queryClient = useQueryClient();
  const [patchError, setPatchError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: userSettingsKeys.all,
    queryFn: ({ signal }) => fetchSettings(signal),
    enabled: userKey !== null,
    retry: (failureCount, error) => {
      // 4xx won't recover by retrying — fail fast (旧版 break 语义)。
      if (error instanceof SettingsHttpError && error.status < 500) return false;
      return failureCount < SETTINGS_RETRY_DELAYS_MS.length;
    },
    retryDelay: (attemptIndex) =>
      SETTINGS_RETRY_DELAYS_MS[attemptIndex] ??
      SETTINGS_RETRY_DELAYS_MS[SETTINGS_RETRY_DELAYS_MS.length - 1],
  });

  const patchMut = useMutation({
    mutationFn: patchSettings,
    onSuccess: (data) => {
      // 响应即新状态 —— 直接写 cache，所有订阅实例立即同步。
      queryClient.setQueryData(userSettingsKeys.all, data);
    },
  });

  const patch = useCallback(
    async (next: UserSettingsPatch): Promise<UserSettings | null> => {
      setPatchError(null);
      try {
        return await patchMut.mutateAsync(next);
      } catch (err) {
        setPatchError(err instanceof Error ? err.message : "Failed to save settings");
        return null;
      }
    },
    [patchMut],
  );

  const refetch = useCallback(async () => {
    await query.refetch();
  }, [query]);

  return {
    settings: query.data ?? null,
    // isPending = 还没有数据（含登出 disabled 的待命态），与旧版
    // 「settingsCache===null 即 loading」语义一致。
    loading: query.isPending,
    saving: patchMut.isPending,
    error:
      patchError ??
      (query.error
        ? query.error instanceof Error
          ? query.error.message
          : "Failed to load settings"
        : null),
    patch,
    refetch,
  };
}
