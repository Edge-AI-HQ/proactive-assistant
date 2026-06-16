/**
 * Platform-aware command-modifier helpers.
 *
 * Mac uses ⌘ (metaKey) as the primary modifier; Windows/Linux use Ctrl
 * (ctrlKey). Detect the platform once so the keydown handlers and the UI
 * hints can never drift apart.
 *
 * navigator.platform is superseded by navigator.userAgentData, but the latter
 * is absent in Safari/Firefox, so platform stays the only modifier-detection
 * that works across every browser we target.
 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Whether the event carries this platform's command modifier (⌘ on Mac, Ctrl elsewhere). */
export function hasCmdModifier(e: KeyboardEvent): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/** Readable hint for a command-modifier shortcut, e.g. "⌘K" on Mac, "Ctrl+K" elsewhere. */
export function shortcutHint(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}
