import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isMainChatEntrySwipeUp,
  isMainMenuSwipeLeft,
  isMainMenuSwipeRight,
  shouldIgnoreMainMenuSwipeTarget,
} from "@/components/chat/main-chat-entry-gesture";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("AppLayout menu order", () => {
  test("matches the minimalist constellation design nav order", () => {
    // MENU_ITEMS moved into SideMenu.tsx (god-component extraction); the
    // nav order it locks is unchanged.
    const source = readFileSync(join(__dirname, "SideMenu.tsx"), "utf8");
    const menuSource = source.match(/const MENU_ITEMS = \[([\s\S]*?)\] as const;/);

    expect(menuSource).not.toBeNull();
    const labels = Array.from(menuSource?.[1].matchAll(/label: "([^"]+)"/g) ?? []).map(
      ([, label]) => label,
    );

    expect(labels).toEqual([
      "NOW",
      "AMBIENT",
      "TASKS",
      "CONNECT",
      "PROFILE",
      "SETTING",
      "PROACTIVE",
    ]);
  });

  test("scopes the ASK PIN AI entry to the NOW view", () => {
    const source = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");

    // Gated on the NOW view AND !inFullscreenChat: card execution keeps
    // activeView "now" while chatTarget is set, so the extra guard stops the
    // entry arrow from floating over the full-screen card conversation.
    expect(source).toMatch(
      /\{activeView === "now" && !inFullscreenChat && \(\s*<button[\s\S]*aria-label="Open main chat"/,
    );
  });

  test("opens the ASK PIN AI entry from an upward swipe", () => {
    expect(isMainChatEntrySwipeUp({ x: 120, y: 720 }, { x: 124, y: 660 })).toBe(true);
    expect(isMainChatEntrySwipeUp({ x: 120, y: 720 }, { x: 121, y: 700 })).toBe(false);
    expect(isMainChatEntrySwipeUp({ x: 120, y: 720 }, { x: 184, y: 676 })).toBe(false);
    expect(isMainChatEntrySwipeUp(null, { x: 120, y: 660 })).toBe(false);
  });

  test("opens the menu from a left swipe on main surfaces", () => {
    expect(isMainMenuSwipeLeft({ x: 360, y: 480 }, { x: 286, y: 486 })).toBe(true);
    expect(isMainMenuSwipeLeft({ x: 360, y: 480 }, { x: 330, y: 482 })).toBe(false);
    expect(isMainMenuSwipeLeft({ x: 360, y: 480 }, { x: 304, y: 548 })).toBe(false);
    expect(isMainMenuSwipeLeft(null, { x: 286, y: 486 })).toBe(false);
  });

  test("closes the menu from a right swipe", () => {
    expect(isMainMenuSwipeRight({ x: 286, y: 486 }, { x: 360, y: 480 })).toBe(true);
    expect(isMainMenuSwipeRight({ x: 286, y: 486 }, { x: 316, y: 480 })).toBe(false);
    expect(isMainMenuSwipeRight({ x: 286, y: 486 }, { x: 342, y: 554 })).toBe(false);
    expect(isMainMenuSwipeRight(null, { x: 360, y: 480 })).toBe(false);
  });

  test("ignores menu swipes that start inside the 3D card sphere", () => {
    const source = readFileSync(join(__dirname, "..", "now", "Sphere3DCards.tsx"), "utf8");
    expect(source).toContain('data-main-menu-swipe-ignore="true"');

    const sphere = document.createElement("div");
    sphere.setAttribute("data-main-menu-swipe-ignore", "true");
    const card = document.createElement("button");
    sphere.appendChild(card);

    expect(shouldIgnoreMainMenuSwipeTarget(card)).toBe(true);
    expect(shouldIgnoreMainMenuSwipeTarget(document.createElement("div"))).toBe(false);
  });

  test("aligns top action buttons with the active page title safe-area height", () => {
    const layoutSource = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");
    // The NOW greeting (which carries the title's paddingTop) moved into
    // NowView.tsx during god-component extraction; the top action buttons
    // (top: ...) stay in the layout. Both still share the same var.
    const nowViewSource = readFileSync(join(__dirname, "..", "now", "NowView.tsx"), "utf8");
    const ambientSource = readFileSync(join(__dirname, "..", "ambient", "AmbientView.tsx"), "utf8");
    const tasksSource = readFileSync(join(__dirname, "..", "tasks", "CardTimeline.tsx"), "utf8");
    const connectSource = readFileSync(join(__dirname, "..", "connect", "ControlPanel.tsx"), "utf8");
    const profileSource = readFileSync(join(__dirname, "..", "profile", "GoalsView.tsx"), "utf8");
    const settingSource = readFileSync(join(__dirname, "..", "account", "AccountPanel.tsx"), "utf8");
    const platformSource = readFileSync(join(__dirname, "..", "..", "lib", "platform.ts"), "utf8");

    expect(layoutSource).toContain("--constellation-header-top");
    expect(layoutSource).toContain(
      "max(4.5rem, calc(max(env(safe-area-inset-top, 0px), var(--safe-top, 0px)) + 0.75rem))",
    );
    expect(layoutSource).toContain('top: "var(--constellation-header-top)"');
    expect(nowViewSource).toContain('paddingTop: "var(--constellation-header-top)"');
    expect(platformSource).toContain("--safe-top");
    expect(layoutSource).not.toContain('className="absolute top-12 right-5');
    expect(layoutSource).not.toContain('className={`-mt-1 p-2');

    for (const source of [ambientSource, tasksSource, connectSource, profileSource, settingSource]) {
      expect(source).toContain("var(--constellation-header-top");
    }
  });

  test("does not add extra top padding around the TASKS view", () => {
    // The activeView dispatch (incl. the TASKS branch) moved into
    // ViewRouter during god-component extraction.
    const source = readFileSync(join(__dirname, "ViewRouter.tsx"), "utf8");
    const tasksBranch = source.match(
      /\) : activeView === "chat" \? \(([\s\S]*?)\) : activeView === "ambient" \? \(/,
    );

    expect(tasksBranch).not.toBeNull();
    expect(tasksBranch?.[1]).toContain("<CardTimeline");
    expect(tasksBranch?.[1]).not.toContain('className="h-full overflow-y-auto pt-12"');
  });

  test("provides shared card state to the TASKS view via context", () => {
    const source = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");
    // cardsState/cardActions reach the Tasks timeline through CardStateContext
    // (phase-2 de-prop-drilling), not 11 individual props. The provider stays
    // in the layout; the TASKS branch that consumes it moved into ViewRouter.
    expect(source).toContain("<CardStateProvider value={{ cardsState, cardActions }}>");
    const routerSource = readFileSync(join(__dirname, "ViewRouter.tsx"), "utf8");
    const tasksBranch = routerSource.match(
      /\) : activeView === "chat" \? \(([\s\S]*?)\) : activeView === "ambient" \? \(/,
    );
    expect(tasksBranch).not.toBeNull();
    expect(tasksBranch?.[1]).toContain("<CardTimeline");
  });

  test("refreshes cards immediately after generation completes", () => {
    const source = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");

    expect(source).toContain("const refreshCards = cardsState.refresh");
    expect(source).toContain("const lastCompleteRunIdRef = useRef<string | null>(null)");
    expect(source).toMatch(
      /if \(pipeline\.run\.status !== "complete" \|\| !pipeline\.run\.runId\) return;[\s\S]*void refreshCards\(\);/,
    );
  });

  test("does not render a separate card feedback drawer button", () => {
    const source = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");

    expect(source).not.toContain("mainChatCardContext");
    expect(source).not.toContain("openMainChatForCardFeedback");
    expect(source).not.toContain("onFeedback");
    expect(source).not.toContain("Give card feedback in PIN AI");
    expect(source).not.toContain("<MessageCircle");
  });

  test("opens Steer as the card feedback conversation without auto voice", () => {
    const source = readFileSync(join(__dirname, "AppLayout.tsx"), "utf8");

    expect(source).not.toContain('autoStartVoice: mode === "steer"');
    expect(source).not.toMatch(/<ChatDetailView[\s\S]*autoStartVoice=/);
    expect(source).toMatch(/onModify=\{\(card\) => \{[\s\S]*void cardActions\.modify\(real\);/);
  });
});
