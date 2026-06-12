import { useCallback, useState } from "react";
import { isNative } from "@/lib/platform";
import {
  getPersistedAmbientEnabled,
  setPersistedAmbientEnabled,
} from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS, type SourceKey } from "@/services/ambient/keys";
import { getExistingAmbientRuntime, type RuntimeStatus } from "@/services/ambient";
import { useUserSettings } from "@pin-ai/state";

export interface UseAmbientToggleResult {
  /** True when the master ambient switch is on. Derived from server-side
   *  consent (`/api/settings.ambientSources`); falls back to the
   *  localStorage boot flag only until settings hydrate. */
  ambientOn: boolean;
  /** True while a toggle is in flight (settings patch + native lifecycle
   *  start/stop). Buttons should disable themselves during this. */
  togglePending: boolean;
  /** Flip the master ambient switch. Does three things in sequence:
   *  1. For enable, write a pending localStorage master flag so App.tsx
   *     does not race the settings PATCH by reconciling sources back off
   *  2. PATCH /api/settings ambientSources for every source → next
   *  3. On native, immediately call lifecycle.start/stopAmbientUpload so
   *     real sensors react without waiting for the next render pass.
   *     If the core sound source fails to start, the local flag is rolled
   *     back and already-started sources are stopped. Other data sources
   *     can be retried by the lifecycle reconciler later.
   *  Safe to call from any view; AmbientView and the NOW-view toggle in
   *  AppLayout share this so flipping from either stays in sync. */
  toggle: () => Promise<void>;
}

/**
 * Single source of truth for the master ambient switch.
 *
 * IMPORTANT — why no local `persistedAmbientOn` state:
 * Each `useAmbientToggle()` call gets its own React state instance, so a
 * toggle from view A wouldn't flip view B's local copy → the two switches
 * desynced. `useUserSettings` already has a module-level cache + listener
 * fan-out, so deriving `ambientOn` purely from `settings.ambientSources`
 * makes every consumer share the same value via that broadcast. localStorage
 * is only read on cold boot (before `consentOn` is known) and written by
 * `toggle` so App.tsx's boot effect can rehydrate sensors.
 */
export function useAmbientToggle(): UseAmbientToggleResult {
  const { settings, patch } = useUserSettings();
  const consentOn = settings
    ? Object.values(settings.ambientSources ?? {}).some((c) => c?.enabled === true)
    : null;
  const [togglePending, setTogglePending] = useState(false);
  // per-device gate: the master switch reads "on" only when server consent
  // is still set AND this device has opted in locally (the localStorage
  // boot flag). A reinstall / new device clears that flag, so ambient shows
  // "off" there — matching App.tsx, which won't auto-start sources without
  // the flag — instead of "UI on but nothing capturing". Before settings
  // hydrate (`consentOn === null`) we fall back to the local flag alone so
  // the UI doesn't flash "off" on cold start for an already-opted-in device.
  const ambientOn =
    consentOn === null
      ? getPersistedAmbientEnabled()
      : consentOn && getPersistedAmbientEnabled();

  const toggle = useCallback(async () => {
    if (togglePending) return;
    const next = !(ambientOn || hasEnabledRuntimeSource());
    setTogglePending(true);
    try {
      const consentPatch = Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: next }]),
      );

      if (!next) {
        setPersistedAmbientEnabled(false);
        if (isNative) {
          const lifecycle = await import("@/services/ambient/lifecycle");
          await lifecycle.stopAmbientUpload();
        }
        await patch({ ambientSources: consentPatch });
        return;
      }

      setPersistedAmbientEnabled(true);
      const updated = await patch({ ambientSources: consentPatch });
      if (!updated) {
        setPersistedAmbientEnabled(false);
        return;
      }
      if (!isNative) return;
      const lifecycle = await import("@/services/ambient/lifecycle");
      const enabledSources = Object.entries(updated.ambientSources ?? {})
        .filter(([, v]) => v?.enabled === true)
        .map(([k]) => k as SourceKey);
      const desiredSources = enabledSources.length > 0 ? enabledSources : ALL_SOURCE_KEYS;
      const status = await lifecycle.startAmbientUpload({
        enabledSources: desiredSources,
        transcriptionLanguage:
          updated.generationLanguage ?? settings?.generationLanguage ?? null,
      });
      if (hasMissingCoreSource(status, desiredSources)) {
        setPersistedAmbientEnabled(false);
        await lifecycle.stopAmbientUpload();
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, patch, settings?.generationLanguage, togglePending]);

  return { ambientOn, togglePending, toggle };
}

function hasEnabledRuntimeSource(): boolean {
  try {
    return getExistingAmbientRuntime()
      ?.status()
      .sources
      .some((source) => source.enabled) === true;
  } catch {
    return false;
  }
}

function hasMissingCoreSource(
  status: RuntimeStatus | null,
  desiredSources: SourceKey[],
): boolean {
  if (!status) return false;
  if (!desiredSources.includes("sound_classifier")) return false;
  const byKey = new Map(status.sources.map((source) => [source.key, source]));
  return byKey.get("sound_classifier")?.enabled !== true;
}
