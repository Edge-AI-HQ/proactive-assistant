import { isNative } from "@/lib/platform";

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
  if (!isNative) return () => {};

  let cancelled = false;
  let removeListener: (() => void) | null = null;
  const dispatch = createSystemShortcutDispatcher(handlers);

  void import("@capacitor/app").then(({ App }) => {
    if (cancelled) return;

    void App.getLaunchUrl().then((launch) => {
      if (!cancelled && launch?.url) dispatch(launch.url);
    });

    void App.addListener("appUrlOpen", ({ url }) => {
      dispatch(url);
    }).then((listener) => {
      if (cancelled) {
        void listener.remove();
        return;
      }
      removeListener = () => {
        void listener.remove();
      };
    });
  });

  return () => {
    cancelled = true;
    removeListener?.();
  };
}
