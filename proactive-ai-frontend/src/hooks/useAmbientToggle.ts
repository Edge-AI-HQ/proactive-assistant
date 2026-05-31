import { useCallback, useState } from "react";
import { isNative } from "@/lib/platform";
import {
  getPersistedAmbientEnabled,
  setPersistedAmbientEnabled,
} from "@/services/ambient/enabled-state";
import { ALL_SOURCE_KEYS, type SourceKey } from "@/services/ambient/keys";
import { useUserSettings } from "./useUserSettings";

export interface UseAmbientToggleResult {
  /** True when the master ambient switch is on. Derived from server-side
   *  consent (`/api/settings.ambientSources`); falls back to the
   *  localStorage boot flag only until settings hydrate. */
  ambientOn: boolean;
  /** True while a toggle is in flight (settings patch + native lifecycle
   *  start/stop). Buttons should disable themselves during this. */
  togglePending: boolean;
  /** Flip the master ambient switch. Does three things in sequence:
   *  1. PATCH /api/settings ambientSources for every source → next
   *  2. Write the localStorage master flag so App.tsx can rehydrate on boot
   *  3. On native, immediately call lifecycle.start/stopAmbientUpload so
   *     real sensors react without waiting for the next render pass.
   *  Safe to call from any view; AmbientView and the NOW-view toggle in
   *  ConstellationLayout share this so flipping from either stays in sync. */
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
    const next = !ambientOn;
    setTogglePending(true);
    try {
      const consentPatch = Object.fromEntries(
        ALL_SOURCE_KEYS.map((key) => [key, { enabled: next }]),
      );
      const updated = await patch({ ambientSources: consentPatch });
      setPersistedAmbientEnabled(next);
      if (!isNative) return;
      const lifecycle = await import("@/services/ambient/lifecycle");
      if (next) {
        const enabledSources = updated
          ? (Object.entries(updated.ambientSources ?? {})
              .filter(([, v]) => v?.enabled === true)
              .map(([k]) => k as SourceKey))
          : ALL_SOURCE_KEYS;
        lifecycle.startAmbientUpload({
          enabledSources: enabledSources.length > 0 ? enabledSources : ALL_SOURCE_KEYS,
          transcriptionLanguage:
            updated?.generationLanguage ?? settings?.generationLanguage ?? null,
        });
      } else {
        await lifecycle.stopAmbientUpload();
      }
    } finally {
      setTogglePending(false);
    }
  }, [ambientOn, patch, settings?.generationLanguage, togglePending]);

  return { ambientOn, togglePending, toggle };
}
