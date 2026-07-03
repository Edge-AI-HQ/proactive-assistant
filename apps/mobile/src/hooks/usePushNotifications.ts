/**
 * 推送权限态（RN）：PreNotificationPrompt 预询流 + 设置·通知子页用——展示
 * OS 权限（granted / denied / prompt）+ 触发系统询问。包 expo-notifications；
 * token 注册/OS 询问复用 lib/push.ts 的 ensurePushRegistration /
 * requestPushPermission（不重写一份）。前台回来（AppState 'active'）重查一次，
 * 接住「用户去系统设置里改完开关再回来」的情况（对应 web usePushNotifications
 * 的 App.addListener('appStateChange')）。
 * web 端（Platform.OS==='web'）无推送 → "unsupported"，开关 UI 应隐藏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";

import {
  ensurePushRegistration,
  requestPushPermission,
  type PushPermissionResult,
} from "../lib/push";

export type PushPermissionState = "unsupported" | PushPermissionResult;

export interface UsePushNotificationsResult {
  /** OS 权限态；UI 据此显示 enabled / denied / 未问 + 决定点开关的行为。 */
  permissionState: PushPermissionState;
  /** 首次 check 完成前为 false，gate 掉依赖态的 UI（否则闪默认值）。 */
  ready: boolean;
  /**
   * 触发系统权限弹窗。iOS 每次安装只弹一次——denied / granted 时是 no-op，
   * 返回当前态。返回结果态，调用方不必等下一帧 render。
   */
  requestPermission: () => Promise<PushPermissionState>;
}

function mapStatus(status: Notifications.PermissionStatus): PushPermissionState {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "prompt"; // undetermined
}

export function usePushNotifications(userId: string | null): UsePushNotificationsResult {
  const native = Platform.OS !== "web";
  const [permissionState, setPermissionState] = useState<PushPermissionState>(
    native ? "prompt" : "unsupported",
  );
  // web 立即就绪（没东西可查）；native 等首次 getPermissions 返回再翻 true。
  const [ready, setReady] = useState(!native);
  const mountedRef = useRef(true);

  // 「读 OS 态 + 反应」的单一入口：mount 时 + 每次回前台都调。
  const recheck = useCallback(async () => {
    if (!native) return;
    try {
      const { status } = await Notifications.getPermissionsAsync();
      const mapped = mapStatus(status);
      if (!mountedRef.current) return;
      setPermissionState(mapped);
      setReady(true);
      // 已授权 → 确保 device token 已注册（静默、幂等，内有 guard）。
      if (mapped === "granted" && userId) void ensurePushRegistration(userId);
    } catch {
      // 瞬时失败也翻 ready，免得消费方卡在 loading；用户可经开关重试。
      if (mountedRef.current) setReady(true);
    }
  }, [native, userId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!native) {
      setPermissionState("unsupported");
      setReady(true);
      return () => {
        mountedRef.current = false;
      };
    }
    void recheck();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void recheck();
    });
    return () => {
      mountedRef.current = false;
      sub.remove();
    };
  }, [native, recheck]);

  const requestPermission = useCallback(async (): Promise<PushPermissionState> => {
    if (!native) return "unsupported";
    // 委托 lib/push（granted 顺手注册 token；异常已按 dev 语义归 "denied"）。
    const mapped = await requestPushPermission(userId);
    if (mountedRef.current) setPermissionState(mapped);
    return mapped;
  }, [native, userId]);

  return { permissionState, ready, requestPermission };
}
