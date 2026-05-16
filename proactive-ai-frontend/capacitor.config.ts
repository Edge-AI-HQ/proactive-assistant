import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.pin.proactive",
  appName: "PIN AI",
  webDir: "dist",
  ios: {
    contentInset: "never",
    // WKWebView 背景色。native 键盘模式下 WebView 会被上推让位给键盘，
    // 这个色是 WebView 自身底色；UIWindow 背景由 AppDelegate 另设，兜底
    // 露出边缘区域。两者都对齐 app background `hsl(220 30% 96%)`，
    // 杜绝任何白 / 黑闪烁。
    backgroundColor: "#F1F3F7",
  },
  server: {
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#F2F0F5",
    },
    Keyboard: {
      // none：Capacitor 不做任何 resize，完全由 JS 层接管（main.tsx 监听
      // keyboardWillShow/Hide 写 --kb-height；MainChatView 的 bottom 绑定到
      // 这个 CSS 变量并配 250ms cubic-bezier 对齐 iOS 键盘动画曲线）。
      // native 模式下 WebView resize 和键盘动画不同步，会出现键盘先盖 composer
      // 再"追上去"的卡顿；JS 同步方案视觉上是一帧同步的平移。
      resize: "none",
      resizeOnFullScreen: true,
    },
    PushNotifications: {
      // 仅注册基础 alert / badge / sound 行为。Critical / Provisional 一类
      // 高权限场景目前不开（也不需要 Apple 单独审批）。
      presentationOptions: ["alert", "badge", "sound"],
    },
  },
};

export default config;
