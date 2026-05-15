import { useCallback, useEffect, useState } from "react";
import {
  listUserDevices,
  registerUserDevice,
  revokeUserDevice,
  type RegisterDeviceInput,
  type UserDevice,
} from "@/lib/api";
import { DEVICE_REGISTERED_EVENT } from "@/lib/device-events";

export interface UseUserDevicesApi {
  devices: UserDevice[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  registerDevice: (input: RegisterDeviceInput) => Promise<{ device: UserDevice; deviceToken: string }>;
  revoke: (deviceId: string) => Promise<void>;
}

/**
 * Multi-device registry for the current user. Lists active devices and
 * exposes register/revoke. Used by the Control Center "Hardware" panel
 * so users can pair a wearable, see the list, drill into a per-device
 * timeline.
 */
export function useUserDevices(autoLoad: boolean = true): UseUserDevicesApi {
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listUserDevices();
      setDevices(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const registerDevice = useCallback(
    async (input: RegisterDeviceInput) => {
      const result = await registerUserDevice(input);
      // Optimistic refresh; ignore race because refresh is idempotent.
      void refresh();
      return result;
    },
    [refresh],
  );

  const revoke = useCallback(
    async (deviceId: string) => {
      await revokeUserDevice(deviceId);
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    if (autoLoad) void refresh();
  }, [autoLoad, refresh]);

  useEffect(() => {
    if (!autoLoad || typeof window === "undefined") return;
    const onDeviceRegistered = () => {
      void refresh();
    };
    window.addEventListener(DEVICE_REGISTERED_EVENT, onDeviceRegistered);
    return () => {
      window.removeEventListener(DEVICE_REGISTERED_EVENT, onDeviceRegistered);
    };
  }, [autoLoad, refresh]);

  return { devices, loading, error, refresh, registerDevice, revoke };
}
