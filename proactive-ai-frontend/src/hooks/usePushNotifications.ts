import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  PushNotifications,
  type PermissionStatus,
} from "@capacitor/push-notifications";
import { ensureDevice } from "@/lib/devices";
import { setDevicePushToken } from "@/lib/api";
import { isNative } from "@/lib/platform";

/**
 * OS-level permission state for push notifications.
 *
 *   - "unsupported": running on web (Capacitor plugin is a no-op there)
 *     OR plugin runtime not available. Toggle UI should hide.
 *   - "prompt": user has never answered the OS prompt; we can still
 *     trigger the system sheet via requestPermission().
 *   - "prompt-with-rationale" / "granted" / "denied": iOS surface
 *     defined by Capacitor.PermissionState. "denied" is sticky on iOS —
 *     once Apple shows the system sheet and the user taps "Don't Allow",
 *     we can't re-trigger it; only Settings can flip it back.
 */
export type PushPermissionState =
  | "unsupported"
  | "prompt"
  | "prompt-with-rationale"
  | "granted"
  | "denied";

export interface UsePushNotificationsResult {
  /** Effective state for UI decisions. See PushPermissionState docs. */
  permissionState: PushPermissionState;
  /**
   * False until the first checkPermissions has resolved. Consumers
   * should gate any state-dependent UI on this — otherwise the initial
   * default ("prompt") would flash before the real value lands.
   */
  ready: boolean;
  /** Reflects whether we've successfully registered a token this session. */
  registered: boolean;
  /**
   * Trigger the OS permission prompt. iOS only shows the system sheet
   * once per install — for "denied" / "granted" states this is a no-op
   * that returns the current state. Returns the resulting state so
   * callers can branch without waiting for the next render.
   */
  requestPermission: () => Promise<PushPermissionState>;
}

function mapPermission(s: PermissionStatus["receive"]): PushPermissionState {
  // Capacitor 8's PermissionState is a string union; we widen it to
  // include "unsupported" for the web-fallback path.
  switch (s) {
    case "granted": return "granted";
    case "denied": return "denied";
    case "prompt-with-rationale": return "prompt-with-rationale";
    default: return "prompt";
  }
}

/**
 * Capacitor push notifications wrapper.
 *
 * Lifecycle (native only — web returns {permissionState:"unsupported"}):
 *   mount    → checkPermissions → setState + (if granted) register
 *   resume   → re-check on every appStateChange:isActive so a user who
 *              flipped the OS toggle while in Settings is reflected
 *              when they return (without this, the toggle UI is stale
 *              until the next cold start — the bug that triggered v2)
 *   token    → PUT /api/devices/{deviceId}/push-token (server idempotent)
 *   error    → log; do nothing destructive (transient APNs network blips
 *              shouldn't flap the user's preference)
 *
 * The hook does NOT auto-trigger requestPermission — that's the user's
 * explicit action via the Account-panel toggle or the
 * PreNotificationPrompt sheet shown on first home mount.
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const [permissionState, setPermissionState] =
    useState<PushPermissionState>(isNative ? "prompt" : "unsupported");
  // Web is considered "ready" immediately — there's nothing to check.
  // Native flips to true once the first checkPermissions resolves.
  const [ready, setReady] = useState(!isNative);
  const [registered, setRegistered] = useState(false);
  const mountedRef = useRef(true);
  const listenersAttachedRef = useRef(false);
  // Per-instance listener handles so cleanup only removes OUR listeners.
  // PushNotifications.removeAllListeners() is global — using it from one
  // hook instance wipes any other instance's listeners too, which is
  // exactly what was dropping the APNs registration token: NotificationSettings
  // (mounted in Account tab) unmount cleanup was killing ConstellationLayout's
  // listeners, so the registration event had nowhere to land.
  const listenerHandlesRef = useRef<PluginListenerHandle[]>([]);

  // Register the OS-issued token with our backend. Tied to the existing
  // device row so /api/devices/list + push send pipeline share state.
  const registerTokenWithServer = useCallback(async (token: string) => {
    console.log("[push] registration listener fired token=%s", token.slice(0, 12) + "…");
    try {
      const creds = await ensureDevice();
      const provider = creds.platform === "ios" ? "apns"
        : creds.platform === "android" ? "fcm"
        : "web";
      await setDevicePushToken(creds.deviceId, token, provider);
      if (mountedRef.current) setRegistered(true);
      console.log("[push] PUT /api/devices/<id>/push-token ok device=%s", creds.deviceId);
    } catch (err) {
      // Don't flip permission state on transient failure — the OS still
      // shows us as granted. Next launch's register() retries.
      console.warn("[push] failed to PUT push token", err);
    }
  }, []);

  // Attach Capacitor's persistent listeners and AWAIT the native side
  // binding before we return. The Capacitor 8 plugin returns a
  // Promise<PluginListenerHandle> from addListener — fire-and-forget
  // ("void promise") had a real race here: register() could fire the
  // APNs "registration" event before the listener was bound, dropping
  // the token. We've seen this in the wild (push_token NULL in DB
  // despite OS=granted).
  const attachListeners = useCallback(async () => {
    if (listenersAttachedRef.current) return;
    try {
      const regHandle = await PushNotifications.addListener("registration", (token) => {
        // token.value is the APNs deviceToken on iOS (hex string), the
        // FCM registration token on Android.
        void registerTokenWithServer(token.value);
      });
      const errHandle = await PushNotifications.addListener("registrationError", (err) => {
        console.warn("[push] registrationError", err);
      });
      listenerHandlesRef.current = [regHandle, errHandle];
      listenersAttachedRef.current = true;
      console.log("[push] listeners bound");
    } catch (err) {
      // Leave the ref false so a subsequent call can retry the binding.
      console.warn("[push] attachListeners failed", err);
      throw err;
    }
  }, [registerTokenWithServer]);

  // Single source of truth for "read OS state and react". Called on
  // mount AND on every foreground transition so the UI can't be stale
  // after a Settings-app round-trip.
  const recheck = useCallback(async () => {
    if (!isNative) return;
    try {
      const status = await PushNotifications.checkPermissions();
      const mapped = mapPermission(status.receive);
      console.log("[push] checkPermissions ->", mapped);
      if (!mountedRef.current) return;
      setPermissionState(mapped);
      setReady(true);
      if (mapped === "granted") {
        // ORDER MATTERS: bind listeners before register() so the
        // APNs "registration" event the native side will fire shortly
        // has somewhere to land.
        await attachListeners();
        await PushNotifications.register();
        console.log("[push] register() called");
      }
    } catch (err) {
      console.warn("[push] check failed", err);
      // Still flip ready so consumers don't hang on the loading state
      // for a transient failure — they'll see the (default) "prompt"
      // value and can re-trigger via the toggle.
      if (mountedRef.current) setReady(true);
    }
  }, [attachListeners]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isNative) {
      setPermissionState("unsupported");
      setReady(true);
      return () => { mountedRef.current = false; };
    }

    void recheck();

    // App.addListener resolves async; track via cancelled flag so a
    // fast unmount before the handle lands still removes the listener.
    let appHandle: PluginListenerHandle | null = null;
    let cancelled = false;
    void App.addListener("appStateChange", (state) => {
      if (state.isActive && mountedRef.current) void recheck();
    }).then((handle) => {
      if (cancelled) void handle.remove();
      else appHandle = handle;
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (appHandle !== null) void appHandle.remove();
      // Only remove THIS instance's handles. removeAllListeners() is
      // global and would wipe other usePushNotifications instances'
      // listeners too — that race was dropping the APNs registration
      // event (see listenerHandlesRef comment).
      for (const h of listenerHandlesRef.current) void h.remove();
      listenerHandlesRef.current = [];
      listenersAttachedRef.current = false;
    };
  }, [recheck]);

  const requestPermission = useCallback(async (): Promise<PushPermissionState> => {
    if (!isNative) return "unsupported";
    try {
      const status = await PushNotifications.requestPermissions();
      const mapped = mapPermission(status.receive);
      console.log("[push] requestPermissions ->", mapped);
      if (mountedRef.current) setPermissionState(mapped);
      if (mapped === "granted") {
        await attachListeners();
        await PushNotifications.register();
        console.log("[push] register() called");
      }
      return mapped;
    } catch (err) {
      console.warn("[push] requestPermission failed", err);
      return "denied";
    }
  }, [attachListeners]);

  return { permissionState, ready, registered, requestPermission };
}
