/**
 * Device 注册（RN）——与 web/Capacitor 同一后端协议：首启生成 UUID
 * device id，POST /api/devices/register 换长期 device token，存
 * expo-secure-store（iOS Keychain）；推送 token 经
 * PUT /api/devices/{id}/push-token 挂到同一 device 行（后端 push 发送
 * 管道按 device 行 gating）。
 *
 * 与 web 版（proactive-ai-frontend/src/lib/devices.ts）的协议细节保持
 * 一致：409（device id 属于同机旧账号）时换新 id 重试；per-owner 隔离
 * （存储里记 ownerUserId，换号不复用旧 creds）。
 */
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { proxyFetch } from "@pin-ai/core";

const DEVICE_ID_KEY = "pin.deviceId";
const DEVICE_TOKEN_KEY = "pin.deviceToken";
const DEVICE_OWNER_KEY = "pin.deviceOwnerUserId";

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
}

let inFlight: { ownerUserId: string; promise: Promise<DeviceCredentials> } | null = null;

async function registerDevice(
  ownerUserId: string,
  proposedDeviceId: string,
): Promise<DeviceCredentials> {
  const body = (deviceId: string) => ({
    deviceId,
    platform: "ios",
    displayName: Device.deviceName ?? "iPhone",
    ...(Device.modelName ? { model: Device.modelName } : {}),
    metadata: { client: "expo-rn", osVersion: Device.osVersion ?? null },
  });
  const post = (deviceId: string) =>
    proxyFetch("/devices/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(deviceId)),
    });

  let res = await post(proposedDeviceId);
  if (res.status === 409) {
    // 同机旧账号占用了这个 id——换新逻辑 id 重试（与 web 同语义）。
    res = await post(crypto.randomUUID());
  }
  if (!res.ok) throw new Error(`/devices/register failed: ${res.status}`);
  const data = (await res.json()) as { deviceId: string; deviceToken: string };
  await SecureStore.setItemAsync(DEVICE_ID_KEY, data.deviceId);
  await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, data.deviceToken);
  await SecureStore.setItemAsync(DEVICE_OWNER_KEY, ownerUserId);
  return { deviceId: data.deviceId, deviceToken: data.deviceToken };
}

/** 取本机 device 凭证；不存在/属于别的账号则注册。并发去重。
 *  forceRefresh：跳过缓存直接重注册（登录时机用——dev App.tsx 的
 *  ensureDevice({ forceRefresh: true }) 同语义，服务端顺带刷新 device 行）。 */
export async function ensureDevice(
  ownerUserId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<DeviceCredentials> {
  const [storedId, storedToken, storedOwner] = await Promise.all([
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(DEVICE_TOKEN_KEY),
    SecureStore.getItemAsync(DEVICE_OWNER_KEY),
  ]);
  if (!opts.forceRefresh && storedId && storedToken && storedOwner === ownerUserId) {
    return { deviceId: storedId, deviceToken: storedToken };
  }
  if (inFlight?.ownerUserId === ownerUserId) return inFlight.promise;
  const promise = registerDevice(ownerUserId, storedId ?? crypto.randomUUID()).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { ownerUserId, promise };
  return promise;
}

/** 上报 APNs token（每次启动重 PUT——后端借此复活软禁用的 token）。 */
export async function setDevicePushToken(deviceId: string, token: string): Promise<void> {
  const res = await proxyFetch(`/devices/${encodeURIComponent(deviceId)}/push-token`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pushToken: token, pushProvider: "apns" }),
  });
  if (!res.ok) throw new Error(`push-token PUT failed: ${res.status}`);
}

/** signOut 清理:清空 secure-store 里的 device 凭据。经 App.tsx
 *  registerSignOutCleanup(@pin-ai/core)注册,signOut 时由 runSignOutCleanups 调用。 */
export async function clearDeviceCredentials(): Promise<void> {
  for (const key of [DEVICE_ID_KEY, DEVICE_TOKEN_KEY, DEVICE_OWNER_KEY]) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  }
}
