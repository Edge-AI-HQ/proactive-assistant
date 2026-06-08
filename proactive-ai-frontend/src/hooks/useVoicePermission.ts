import { useCallback, useEffect, useState } from "react";
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { AmbientAi } from "@pin/capacitor-ambient-ai";
import { isNative } from "@/lib/platform";

/**
 * Microphone permission state for the home empty-state "Turn on voice" nudge.
 *
 *   - "granted"     — OS mic permission is granted; ambient sensing can hear.
 *   - "missing"     — not yet granted (prompt / denied). The caller decides
 *                     the fallback (request inline, or route to the Ambient
 *                     permissions panel when the OS won't re-prompt).
 *   - "unsupported" — web build: there are no native ambient sensors, so the
 *                     voice row is hidden entirely (web mic is requested
 *                     on-demand by the voice-chat button, not here).
 *
 * Reads via `AmbientAi.sound.checkPermissions()` (the same module the
 * sound-classifier source enables), so it never forces an OS prompt on mount.
 */
export type VoicePermissionState = "granted" | "missing" | "unsupported";

export interface UseVoicePermission {
  state: VoicePermissionState;
  /** Fire the OS mic permission dialog. Resolves to the new state so the
   *  caller can branch (e.g. route to the permissions panel on non-grant). */
  request: () => Promise<VoicePermissionState>;
  /** Re-read the current OS permission without prompting. */
  refresh: () => Promise<void>;
}

export function useVoicePermission(): UseVoicePermission {
  const [state, setState] = useState<VoicePermissionState>(
    isNative ? "missing" : "unsupported",
  );

  const refresh = useCallback(async () => {
    if (!isNative) {
      setState("unsupported");
      return;
    }
    try {
      const perm = await AmbientAi.sound.checkPermissions();
      setState(perm.microphone === "granted" ? "granted" : "missing");
    } catch {
      // Treat a failed read as "missing" — the nudge stays visible, which is
      // the safe default (better to over-offer the CTA than hide it).
      setState("missing");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read on foreground: the user may have changed the mic permission in
  // iOS Settings (or the Ambient permissions panel triggered the system
  // alert) while we were backgrounded, so the cached state can be stale.
  useEffect(() => {
    if (!isNative) return;
    let handle: PluginListenerHandle | undefined;
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void refresh();
    }).then((h) => {
      handle = h;
    });
    return () => {
      void handle?.remove();
    };
  }, [refresh]);

  const request = useCallback(async (): Promise<VoicePermissionState> => {
    if (!isNative) return "unsupported";
    try {
      const perm = await AmbientAi.sound.requestPermissions();
      const next: VoicePermissionState =
        perm.microphone === "granted" ? "granted" : "missing";
      setState(next);
      return next;
    } catch {
      setState("missing");
      return "missing";
    }
  }, []);

  return { state, request, refresh };
}
