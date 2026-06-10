import { describe, expect, test, vi } from "vitest";
import {
  createSystemShortcutDispatcher,
  parseSystemShortcutUrl,
} from "./system-shortcuts";

describe("system shortcuts", () => {
  test("parses the supported shortcut URLs", () => {
    expect(parseSystemShortcutUrl("ai.pin.proactive.dev://shortcut/toggle-ambient")).toBe("toggle-ambient");
    expect(parseSystemShortcutUrl("ai.pin.proactive.dev://shortcut/generate-cards")).toBe("generate-cards");
    expect(parseSystemShortcutUrl("ai.pin.proactive.dev://shortcut?action=generate-cards")).toBe("generate-cards");
  });

  test("ignores non-shortcut app URLs", () => {
    expect(parseSystemShortcutUrl("ai.pin.proactive.dev://auth/callback?code=abc")).toBeNull();
    expect(parseSystemShortcutUrl("https://pinai.example/shortcut/generate-cards")).toBeNull();
    expect(parseSystemShortcutUrl("not a url")).toBeNull();
  });

  test("dispatches supported actions to the matching handler", () => {
    const toggleAmbient = vi.fn();
    const generateCards = vi.fn();
    const dispatch = createSystemShortcutDispatcher({
      onToggleAmbient: toggleAmbient,
      onGenerateCards: generateCards,
    });

    expect(dispatch("ai.pin.proactive.dev://shortcut/toggle-ambient")).toBe(true);
    expect(dispatch("ai.pin.proactive.dev://shortcut/generate-cards")).toBe(true);
    expect(dispatch("ai.pin.proactive.dev://auth/callback?code=abc")).toBe(false);

    expect(toggleAmbient).toHaveBeenCalledTimes(1);
    expect(generateCards).toHaveBeenCalledTimes(1);
  });
});
