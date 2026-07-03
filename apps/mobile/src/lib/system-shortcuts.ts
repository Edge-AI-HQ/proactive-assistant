/**
 * Siri Shortcuts / 系统深链 dispatcher
 * （dev `proactive-ai-frontend/src/services/system-shortcuts.ts` 的 RN 版）：
 * scheme://shortcut/{toggle-ambient,generate-cards}，支持 ?action= 兜底。
 * 介质差异：launch URL 重放 + 前台 URL 监听从 @capacitor/app 换 expo-linking；
 * scheme 由 app.json 声明（ai.pin.proactive.dev）。动作绑定挂 AppShell
 * （dev AppLayout 同位：handlers ref + bindSystemShortcutActions effect）。
 */
import { Platform } from "react-native";
import * as Linking from "expo-linking";

export type SystemShortcutAction = "toggle-ambient" | "generate-cards";

const SUPPORTED_ACTIONS = new Set<SystemShortcutAction>([
  "toggle-ambient",
  "generate-cards",
]);

export interface SystemShortcutHandlers {
  onToggleAmbient: () => void;
  onGenerateCards: () => void;
}

function normalizeAction(value: string | null): SystemShortcutAction | null {
  if (!value) return null;
  return SUPPORTED_ACTIONS.has(value as SystemShortcutAction)
    ? value as SystemShortcutAction
    : null;
}

export function parseSystemShortcutUrl(url: string): SystemShortcutAction | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
    if (parsed.hostname !== "shortcut") return null;

    const pathAction = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    return normalizeAction(pathAction) ?? normalizeAction(parsed.searchParams.get("action"));
  } catch {
    return null;
  }
}

export function createSystemShortcutDispatcher(handlers: SystemShortcutHandlers) {
  return (url: string): boolean => {
    const action = parseSystemShortcutUrl(url);
    if (!action) return false;

    console.info("[system-shortcut] dispatching", action);
    if (action === "toggle-ambient") {
      handlers.onToggleAmbient();
      return true;
    }

    handlers.onGenerateCards();
    return true;
  };
}

export function bindSystemShortcutActions(handlers: SystemShortcutHandlers): () => void {
  // RN-web 预览没有 scheme 深链（dev 版同位的 isNative gate）。
  if (Platform.OS === "web") return () => {};

  let cancelled = false;
  const dispatch = createSystemShortcutDispatcher(handlers);

  // 冷启重放：app 由快捷指令拉起时，URL 在监听挂上之前就已送达。
  void Linking.getInitialURL().then((launchUrl) => {
    if (!cancelled && launchUrl) dispatch(launchUrl);
  });

  const subscription = Linking.addEventListener("url", ({ url }) => {
    dispatch(url);
  });

  return () => {
    cancelled = true;
    subscription.remove();
  };
}
