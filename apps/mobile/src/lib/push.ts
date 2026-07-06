/**
 * APNs 推送注册（RN）。bundle id 与 Capacitor dev app 相同
 * （ai.pin.proactive.development）——后端的 APNs key/发送管道零改动直接
 * 工作。用**原生 device token**（getDevicePushTokenAsync），不走 Expo
 * 推送服务（后端直连 APNs）。
 *
 * 两个入口（对齐 dev 的 opt-in 预询流：AppLayout + PreNotificationPrompt）：
 *   - ensurePushRegistration()：OS 已 granted 才静默注册 token 上报，
 *     启动时/回前台调，**绝不弹 OS 询问**。
 *   - requestPushPermission()：弹 OS 权限询问（iOS 每次安装只真弹一次），
 *     granted 顺手注册 token；由 PreNotificationPrompt 预询流与设置·通知
 *     开关（经 usePushNotifications）触发。
 */
import * as Notifications from "expo-notifications";

import { ensureDevice, setDevicePushToken } from "./devices";

// 前台收到通知的呈现行为——对齐 dev capacitor.config.ts 的 PushNotifications
// presentationOptions ["alert","badge","sound"]（banner≈alert；shouldShowList
// 是 RN/iOS 通知中心列表位，随 alert 同开）。
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/** OS 询问结果态（expo undetermined → "prompt"）。 */
export type PushPermissionResult = "granted" | "denied" | "prompt";

function mapStatus(status: Notifications.PermissionStatus): PushPermissionResult {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "prompt"; // undetermined
}

let registered = false;

/** token 注册链（ensureDevice + PUT push-token），模块级 guard 幂等。 */
async function registerToken(ownerUserId: string): Promise<void> {
  if (registered) return;
  try {
    const [creds, token] = await Promise.all([
      ensureDevice(ownerUserId),
      Notifications.getDevicePushTokenAsync(),
    ]);
    await setDevicePushToken(creds.deviceId, String(token.data));
    registered = true;
    console.log(`[push] APNs token registered device=${creds.deviceId}`);
  } catch (err) {
    // 本地个人签名 build 会主动剥掉 aps-environment entitlement（免费 team 签不了
    // 推送，见 skill build 脚本）——这里注册必失败，是**预期**的本地 dev 现象，不是
    // bug。dev/prod（TestFlight，付费 team distribution profile）保留 entitlement、
    // 不走这个分支。故把"缺 entitlement"降级为 info：既不再刷 RN 底部黄框，也让真正
    // 的推送故障（有 entitlement 却失败）仍以 warn 冒头、不被淹没。
    const message = err instanceof Error ? err.message : String(err);
    const expectedNoEntitlement = message.includes("aps-environment");
    if (expectedNoEntitlement) {
      console.log("[push] no aps-environment entitlement (local personal-team build) — push off");
    } else {
      console.warn("[push] registration failed (will retry next launch):", err);
    }
  }
}

/**
 * 静默注册：OS 已 granted 才上报 token，未授权直接返回、**不弹询问**。
 * 启动（App.tsx 登录 effect）与 usePushNotifications 的前台 recheck 调。
 */
export async function ensurePushRegistration(ownerUserId: string): Promise<void> {
  if (registered) return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      console.log("[push] permission not granted — skipping silent registration");
      return;
    }
  } catch (err) {
    console.warn("[push] permission check failed", err);
    return;
  }
  await registerToken(ownerUserId);
}

/**
 * 登出复位注册闸。同一 JS 进程里换账号后（RN 无 reload）需重新注册 APNs
 * token——新账号是不同 device owner，latch 不复位会导致「换账号收不到通知」。
 * App.tsx 经 registerSignOutCleanup 挂载。
 */
export function resetPushRegistration(): void {
  registered = false;
}

/**
 * 弹 OS 权限询问并返回结果态（granted 顺手注册 token）。iOS 每次安装只真弹
 * 一次——denied / granted 后是返回现状的 no-op。ownerUserId 为 null 时只询问
 * 不注册（实际消费方都在登录树内）。失败按 dev usePushNotifications 语义
 * 归 "denied"（调用方只在 granted 时 patch 偏好，不会误开）。
 */
export async function requestPushPermission(
  ownerUserId: string | null,
): Promise<PushPermissionResult> {
  try {
    const { status } = await Notifications.requestPermissionsAsync();
    const mapped = mapStatus(status);
    if (mapped === "granted" && ownerUserId) await registerToken(ownerUserId);
    return mapped;
  } catch (err) {
    console.warn("[push] requestPermission failed", err);
    return "denied";
  }
}
