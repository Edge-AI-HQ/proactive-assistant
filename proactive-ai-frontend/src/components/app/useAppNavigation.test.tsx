import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useAppNavigation } from "@/components/app/useAppNavigation";
import type { IntentCard } from "@pin-ai/core";
import type { LiveSession } from "@/services/ambient/live-session";

const fakeCard: IntentCard = {
  id: "c1",
  intentKey: "work:x",
  goalBasket: "work",
  title: "T",
  whyNow: "w",
  summary: "s",
  primaryAction: { label: "do", type: "confirm" },
  secondaryActions: [],
  confidence: 0.9,
  urgency: 0.9,
  importance: 0.9,
  sources: [],
  sourceApps: [],
  reasoningSteps: [],
  agentChain: [],
  createdAt: "",
};

const fakeLive = {} as unknown as LiveSession;

beforeEach(() => window.sessionStorage.clear());

describe("useAppNavigation", () => {
  test("defaults activeView to 'now' and persists navigateTo", () => {
    const { result } = renderHook(() => useAppNavigation());
    expect(result.current.activeView).toBe("now");
    act(() => result.current.navigateTo("ambient"));
    expect(result.current.activeView).toBe("ambient");
    expect(window.sessionStorage.getItem("pai-active-view")).toBe("ambient");
  });

  test("navigateTo clears card-chat overlays and closes the menu", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.openCardChat(fakeCard));
    act(() => result.current.setMenuOpen(true));
    act(() => result.current.navigateTo("chat"));
    expect(result.current.chatTarget).toBeNull();
    expect(result.current.activeChat).toBeNull();
    expect(result.current.menuOpen).toBe(false);
    expect(result.current.activeView).toBe("chat");
  });

  test("navigateTo re-enters Setting at the top level (no stale sub-page)", () => {
    const { result } = renderHook(() => useAppNavigation());
    // Drill into a Setting sub-page, leave for another view, then come back.
    act(() => {
      result.current.navigateTo("account");
      result.current.setSettingsSubPage("ambient");
    });
    expect(result.current.settingsSubPage).toBe("ambient");
    act(() => result.current.navigateTo("now"));
    act(() => result.current.navigateTo("account"));
    expect(result.current.settingsSubPage).toBe("main");
    expect(result.current.activeView).toBe("account");
  });

  test("goBack closes layers in priority order (live > menu > card chat)", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => {
      result.current.setLiveOverlay(fakeLive);
      result.current.setMenuOpen(true);
      result.current.openCardChat(fakeCard);
    });

    let consumed = false;
    act(() => { consumed = result.current.goBack(); });
    expect(consumed).toBe(true);
    expect(result.current.liveOverlay).toBeNull();
    expect(result.current.menuOpen).toBe(true); // live was on top

    act(() => { result.current.goBack(); });
    expect(result.current.menuOpen).toBe(false);
    expect(result.current.chatTarget).not.toBeNull();

    act(() => { result.current.goBack(); });
    expect(result.current.chatTarget).toBeNull();
  });

  test("goBack returns false on a top-level view (nothing to pop)", () => {
    const { result } = renderHook(() => useAppNavigation());
    let consumed = true;
    act(() => { consumed = result.current.goBack(); });
    expect(consumed).toBe(false);
    expect(result.current.activeView).toBe("now");
  });

  test("goBack pops settings sub-page back to main", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => {
      result.current.navigateTo("account");
      result.current.setSettingsSubPage("subscription");
    });
    let consumed = false;
    act(() => { consumed = result.current.goBack(); });
    expect(consumed).toBe(true);
    expect(result.current.settingsSubPage).toBe("main");
    expect(result.current.activeView).toBe("account");
  });

  test("card chat restores the view it was opened from", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.navigateTo("ambient"));
    act(() => result.current.openCardChat(fakeCard, "boot"));
    act(() => { result.current.goBack(); });
    expect(result.current.chatTarget).toBeNull();
    expect(result.current.activeView).toBe("ambient");
  });

  test("main chat opens then goBack closes it and returns to now", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.navigateTo("ambient"));
    act(() => result.current.openMainChat());
    expect(result.current.mainChatOpen).toBe(true);
    act(() => { result.current.goBack(); });
    expect(result.current.mainChatOpen).toBe(false);
    expect(result.current.activeView).toBe("now");
  });
});
