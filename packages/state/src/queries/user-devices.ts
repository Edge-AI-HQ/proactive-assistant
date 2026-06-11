import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listUserDevices,
  registerUserDevice,
  revokeUserDevice,
  type RegisterDeviceInput,
  type UserDevice,
} from "@pin-ai/core";

export const userDevicesKeys = {
  all: ["user-devices"] as const,
};

export interface UseUserDevicesApi {
  devices: UserDevice[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  registerDevice: (input: RegisterDeviceInput) => Promise<{ device: UserDevice; deviceToken: string }>;
  revoke: (deviceId: string) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Multi-device registry for the current user. Lists active devices and
 * exposes register/revoke. Used by the Control Center "Hardware" panel
 * so users can pair a wearable, see the list, drill into a per-device
 * timeline.
 *
 * 迁移注：原版监听 window 的 DEVICE_REGISTERED_EVENT 自制事件刷新；现在
 * lib/devices.ts 的注册路径直接 invalidate `userDevicesKeys.all`（见
 * emitDeviceRegistered），事件机制已删除。
 */
export function useUserDevices(autoLoad: boolean = true): UseUserDevicesApi {
  const queryClient = useQueryClient();
  const [mutationError, setMutationError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: userDevicesKeys.all,
    queryFn: () => listUserDevices(),
    enabled: autoLoad,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: userDevicesKeys.all }),
    [queryClient],
  );

  const registerMut = useMutation({ mutationFn: registerUserDevice, onSuccess: invalidate });
  const revokeMut = useMutation({ mutationFn: revokeUserDevice, onSuccess: invalidate });

  const registerDevice = useCallback(
    async (input: RegisterDeviceInput) => registerMut.mutateAsync(input),
    [registerMut],
  );

  const revoke = useCallback(
    async (deviceId: string) => {
      await revokeMut.mutateAsync(deviceId);
    },
    [revokeMut],
  );

  const refresh = useCallback(async () => {
    setMutationError(null);
    try {
      await query.refetch();
    } catch (err) {
      setMutationError(errorMessage(err));
    }
  }, [query]);

  return {
    devices: query.data ?? [],
    loading: query.isLoading,
    error: mutationError ?? (query.error ? errorMessage(query.error) : null),
    refresh,
    registerDevice,
    revoke,
  };
}
