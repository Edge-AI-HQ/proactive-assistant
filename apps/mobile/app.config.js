// PIN AI iOS app 配置(原 app.json)。改成 JS 是为了按 APP_VARIANT 出三套身份:
//   (不设)   本地真机开发 —— bundle ai.pin.proactive.dev(build-rn-device.sh 会再覆盖成个人后缀)
//   ci-dev    CI dev TestFlight  —— bundle/scheme ai.pin.proactive.development(接替 Capacitor build-ios.yml dev)
//   prod      CI prod TestFlight —— bundle/scheme ai.pin.proactive,显示名 "PIN AI"
//
// 约定(与 Capacitor build-ios.sh 一致):OAuth 回跳 scheme = 本变体 bundle id,
// dev/prod 同装一台设备时回调不串;三个 scheme 都已在 Supabase Redirect URLs 白名单。
// expo.name 固定 "PIN AI Dev":prebuild 由它派生 Xcode 工程名 PINAIDev,变体间不能漂移;
// 用户看到的名字走 infoPlist.CFBundleDisplayName。
// CFBundleVersion(构建号)由 CI 经 APP_BUILD_NUMBER 注入(1000 + run#,高于 Capacitor
// 轨道的 200 + run#,同一 TestFlight app 记录下 RN 构建始终排在前面);本地默认 1。

const VARIANTS = {
  default: { bundleId: "ai.pin.proactive.dev", displayName: "PIN AI Dev" },
  "ci-dev": { bundleId: "ai.pin.proactive.development", displayName: "PIN AI Dev" },
  prod: { bundleId: "ai.pin.proactive", displayName: "PIN AI" },
};

const variantName = process.env.APP_VARIANT || "default";
const variant = VARIANTS[variantName];
if (!variant) {
  throw new Error(`Unknown APP_VARIANT "${variantName}" (expected ci-dev | prod | unset)`);
}

module.exports = {
  expo: {
    name: "PIN AI Dev",
    slug: "pin-ai",
    version: process.env.APP_MARKETING_VERSION || "1.0",
    orientation: "portrait",
    scheme: variant.bundleId,
    userInterfaceStyle: "light",
    newArchEnabled: true,
    icon: "./assets/icon.png",
    ios: {
      bundleIdentifier: variant.bundleId,
      buildNumber: process.env.APP_BUILD_NUMBER || "1",
      supportsTablet: false,
      infoPlist: {
        CFBundleDisplayName: variant.displayName,
        ITSAppUsesNonExemptEncryption: false,
        NSLocationWhenInUseUsageDescription:
          "PIN AI uses your location to understand context for proactive suggestions.",
        NSCalendarsUsageDescription: "PIN AI reads upcoming events to prepare timely cards.",
        NSCalendarsFullAccessUsageDescription:
          "PIN AI reads upcoming events to prepare timely cards.",
        NSHealthShareUsageDescription:
          "PIN AI reads steps, heart rate and sleep to understand your day.",
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "PIN AI detects place arrivals and departures in the background to understand your day.",
        NSMotionUsageDescription:
          "PIN AI uses motion activity (walking, driving) to understand context.",
        NSMicrophoneUsageDescription:
          "PIN AI listens for ambient sounds and conversations (on-device gated) to understand context.",
        NSSpeechRecognitionUsageDescription:
          "PIN AI transcribes ambient speech on-device to capture useful moments.",
        NSFocusStatusUsageDescription:
          "PIN AI reads whether you're in a Focus mode to gauge your availability for proactive suggestions.",
        UIBackgroundModes: ["audio", "location", "fetch", "remote-notification"],
        // NSFocusStatusUsageDescription 保留:ambient 的 focus 源(INFocusStatusCenter)
        // 代码仍在、无 entitlement 时优雅降级,但权限弹窗若被触发缺该串会崩。
      },
      // focus-status entitlement 2026-07-08 拍板放弃(App ID 不登记该能力,分发
      // 签名会拒;信号价值不抵证书维护成本)。要恢复:App ID 勾 Focus Status +
      // 重发 profile + 此处加回 entitlements["com.apple.developer.focus-status"]=true。
      appleTeamId: "58AXBDC7K4",
    },
    platforms: ["ios", "web"],
    experiments: {
      typedRoutes: false,
    },
    plugins: [
      [
        "expo-build-properties",
        {
          ios: {
            deploymentTarget: "17.0",
            extraPods: [
              {
                name: "FluidAudio",
                git: "https://github.com/FluidInference/FluidAudio.git",
                tag: "v0.14.8",
              },
            ],
          },
        },
      ],
      "expo-secure-store",
      "expo-notifications",
      "@kingstinct/react-native-healthkit",
      "expo-font",
      "expo-video",
      "expo-audio",
      "@react-native-community/datetimepicker",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#F0E9F6",
        },
      ],
    ],
  },
};
