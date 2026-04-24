import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { isNative } from "./lib/platform";
import ErrorBoundary from "./components/ErrorBoundary";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Native platform initialization
if (isNative) {
  StatusBar.setStyle({ style: Style.Light }).catch(() => {});
  SplashScreen.hide().catch(() => {});

  // iOS 键盘同步：Capacitor 的 resize 动画和键盘动画不同步会导致 composer
  // 先被键盘盖住再"追上去"的卡顿。改用 resize:"none" + JS 监听 keyboardWill*
  // 写入 --kb-height，由 MainChatView 绑定 bottom/transition 做一帧同步的位移。
  void import("@capacitor/keyboard").then(({ Keyboard }) => {
    Keyboard.addListener("keyboardWillShow", (info) => {
      document.documentElement.style.setProperty(
        "--kb-height",
        `${info.keyboardHeight}px`,
      );
      // Global event so any component (MainChatView dismiss button,
      // BrowserPanel auto-compact) can react without polling CSS vars.
      window.dispatchEvent(new CustomEvent("pinai:kbShow"));
    }).catch(() => {});
    Keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.style.setProperty("--kb-height", "0px");
      window.dispatchEvent(new CustomEvent("pinai:kbHide"));
    }).catch(() => {});
  }).catch(() => {});
}
