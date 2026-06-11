import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
// 注入 @pin-ai/core 的 transport 配置（auth/baseUrl/平台 headers）。
// `@/lib/api` shim 也会触发同一配置；这里显式 import 保证未来直接消费
// @pin-ai/core 的代码（Phase 2+ 的 state 层）不依赖 shim 的加载顺序。
import "./lib/transport-bootstrap";
import { isNative } from "./lib/platform";
import ErrorBoundary from "@/components/app/ErrorBoundary";
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

  // Bind ambient outbox drain to app lifecycle. Drain is privacy-safe
  // (no source starts here, no event captured) — it just flushes the
  // already-queued events. Source startup is opt-in only and lives in
  // App.tsx after the user logs in and we have their ambient_sources
  // settings. Dynamic import keeps web bundles free of native plugins.
  void import("./services/ambient/lifecycle").then(({ bindAmbientLifecycle }) => {
    bindAmbientLifecycle();
  });

  // iOS 键盘同步：Capacitor 的 resize 动画和键盘动画不同步会导致 composer
  // 先被键盘盖住再"追上去"的卡顿。改用 resize:"none" + JS 监听 keyboardWill*
  // 写入 --kb-height，由 MainChatView 绑定 bottom/transition 做一帧同步的位移。
  //
  // 第二条通用机制：对于嵌在滚动容器里的 <input> / <textarea>（比如
  // ChatDetailView 的 NEEDS YOUR INPUT 面板、其它 card 内嵌 input），它们
  // 没法 fixed-position 浮到键盘上，得让它们最近的可滚动祖先元素 scroll
  // 到把 input 抬到键盘上方。`bringFocusedInputAboveKeyboard` 用 visualViewport
  // 算 input 底沿和键盘顶沿的重叠量，向上 scroll 那个量。对 MainChatView
  // 已有方案无干扰——它的 composer 是 fixed 在 body 上的、不在任何 overflow
  // 滚动容器内，循环找不到可滚动祖先就走 window scroll fallback，但
  // composer 已经靠 --kb-height 浮上去了，rect.bottom <= 键盘顶，根本进不到
  // 滚动分支。
  // Track which container we've padded so keyboardWillHide can clean up.
  let paddedScroller: HTMLElement | null = null;
  let originalPadBottom = "";

  void import("@capacitor/keyboard").then(({ Keyboard }) => {
    Keyboard.addListener("keyboardWillShow", (info) => {
      document.documentElement.style.setProperty(
        "--kb-height",
        `${info.keyboardHeight}px`,
      );
      // Global event so any component (MainChatView dismiss button,
      // BrowserPanel auto-compact) can react without polling CSS vars.
      window.dispatchEvent(new CustomEvent("pinai:kbShow"));
      const padded = liftFocusedInputAboveKeyboard(info.keyboardHeight);
      if (padded) {
        paddedScroller = padded.scroller;
        originalPadBottom = padded.originalPadBottom;
      }
    }).catch(() => {});
    Keyboard.addListener("keyboardWillHide", () => {
      document.documentElement.style.setProperty("--kb-height", "0px");
      window.dispatchEvent(new CustomEvent("pinai:kbHide"));
      if (paddedScroller) {
        paddedScroller.style.paddingBottom = originalPadBottom;
        paddedScroller = null;
        originalPadBottom = "";
      }
    }).catch(() => {});
  }).catch(() => {});
}

/**
 * When the iOS keyboard appears and the focused <input> / <textarea> is
 * embedded inside a scrolling chat list (e.g. ChatDetailView's NEEDS YOUR
 * INPUT panel, future card-chat reply boxes), the panel sits at the bottom
 * of the scroll content and the keyboard physically covers it.
 *
 * Pure `scrollIntoView` / `scrollTop += overlap` does not solve this when
 * the scroller is already at max scrollTop — the browser clamps the
 * increment and nothing moves. We need to first **reserve** keyboard-height
 * worth of bottom padding on the scroller (giving it virtual room to scroll
 * further), then scroll the input into the visible area above the keyboard.
 * keyboardWillHide reverses the padding.
 *
 * This is the same pattern WeChat / Telegram use: scroll container reserves
 * keyboard space, last bubble can scroll past the keyboard top.
 *
 * Returns the scroller it modified so the caller can restore padding on
 * keyboardWillHide, or `null` if no adjustment was needed (e.g. focus
 * outside an editable, or the input was already above the keyboard such as
 * MainChatView's fixed composer).
 */
function liftFocusedInputAboveKeyboard(
  keyboardHeight: number,
): { scroller: HTMLElement; originalPadBottom: string } | null {
  const target = document.activeElement as HTMLElement | null;
  if (!target) return null;
  const tag = target.tagName;
  const isEditable =
    tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
  if (!isEditable) return null;

  // window.innerHeight stays at full screen under Capacitor `resize: "none"`,
  // and visualViewport.height does NOT reliably shrink in that mode either —
  // both can leave us computing a negative overlap and silently no-op.
  // Trust the keyboard height we got from the native event instead.
  const visualHeight = window.innerHeight - keyboardHeight;
  const breathingRoom = 24;
  const rect = target.getBoundingClientRect();
  const overlap = rect.bottom + breathingRoom - visualHeight;
  if (overlap <= 0) return null;

  // Walk up to the nearest scrollable ancestor. overflow auto/scroll/overlay
  // count; hidden/visible do not.
  let scroller: HTMLElement | null = target.parentElement;
  while (scroller && scroller !== document.body) {
    const style = window.getComputedStyle(scroller);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      break;
    }
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === document.body) return null;

  // Reserve keyboard space so the scroller has room to push content past the
  // keyboard top. Without this, scrollTop += overlap gets clamped because
  // the content is already at its max scroll extent.
  const originalPadBottom = scroller.style.paddingBottom;
  const currentPadPx =
    parseFloat(window.getComputedStyle(scroller).paddingBottom) || 0;
  scroller.style.paddingBottom = `${currentPadPx + keyboardHeight}px`;

  // Force a synchronous layout flush so scrollHeight reflects the new
  // padding BEFORE we set scrollTop. `requestAnimationFrame` is not enough
  // here — rAF runs before paint but doesn't guarantee layout has been
  // committed for style changes made in the same task. Reading scrollHeight
  // forces the browser to commit pending layout work.
  void scroller.scrollHeight;
  scroller.scrollTop = scroller.scrollTop + overlap;

  return { scroller, originalPadBottom };
}
