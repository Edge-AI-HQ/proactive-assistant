/**
 * APNs 推送注册（RN）。bundle id 与 Capacitor dev app 相同
 * （ai.pin.proactive.development）——后端的 APNs key/发送管道零改动直接
 * 工作。用**原生 device token**（getDevicePushTokenAsync），不走 Expo
 * 推送服务（后端直连 APNs）。
 *
 * 权限请求时机：登录后立即问（async-heavy app 的通知是核心体验，
 * 不做 in-context 延迟请求）。
 */
import * as Notifications from "expo-notifications";

import { ensureDevice, setDevicePushToken } from "./devices";

// 前台收到通知也显示横幅（默认 iOS 前台静默）。
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let registered = false;

export async function registerPush(ownerUserId: string): Promise<void> {
  if (registered) return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    let granted = status === "granted";
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = req.status === "granted";
    }
    if (!granted) {
      console.log("[push] permission denied — skipping registration");
      return;
    }
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
