/**
 * Gesture-intent parsing for the transcript scroller. jsdom has no real
 * layout/scrolling, but intent detection only reads event fields + scrollTop,
 * so synthetic events cover the contract:
 *   - upward intent comes ONLY from input events (wheel/touch/keys) or a
 *     mouse-held upward scroll (scrollbar drag)
 *   - downward input never signals
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  attachScrollIntentListeners,
  type ScrollIntentCallbacks,
} from "./scroll-intent";

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true });
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v });
  }
  target.dispatchEvent(e);
}

describe("attachScrollIntentListeners", () => {
  let el: HTMLDivElement;
  let cb: ScrollIntentCallbacks;
  let detach: () => void;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    cb = {
      onScrollUpIntent: vi.fn(),
      onTouchStart: vi.fn(),
      onTouchEnd: vi.fn(),
    };
    detach = attachScrollIntentListeners(el, cb);
  });

  afterEach(() => {
    detach();
    el.remove();
  });

  test("wheel up signals, wheel down does not", () => {
    fire(el, "wheel", { deltaY: -12 });
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
    fire(el, "wheel", { deltaY: 30 });
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
  });

  test("ctrl+wheel (trackpad pinch-zoom) never signals", () => {
    fire(el, "wheel", { deltaY: -12, ctrlKey: true });
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
  });

  test("multi-touch: the gesture ends only when the last finger lifts", () => {
    fire(el, "touchstart", { touches: [{ clientY: 300 }, { clientY: 400 }] });
    fire(el, "touchend", { touches: [{ clientY: 400 }] }); // one finger still down
    expect(cb.onTouchEnd).not.toHaveBeenCalled();
    fire(el, "touchend", { touches: [] });
    expect(cb.onTouchEnd).toHaveBeenCalledTimes(1);
  });

  test("touch drag down the screen (scroll up) signals past the slop", () => {
    fire(el, "touchstart", { touches: [{ clientY: 300 }] });
    expect(cb.onTouchStart).toHaveBeenCalledTimes(1);
    fire(el, "touchmove", { touches: [{ clientY: 304 }] }); // within slop
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
    fire(el, "touchmove", { touches: [{ clientY: 320 }] });
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
    fire(el, "touchend", { touches: [] });
    expect(cb.onTouchEnd).toHaveBeenCalledTimes(1);
  });

  test("touch drag up the screen (scroll down) never signals", () => {
    fire(el, "touchstart", { touches: [{ clientY: 300 }] });
    fire(el, "touchmove", { touches: [{ clientY: 240 }] });
    fire(el, "touchmove", { touches: [{ clientY: 180 }] });
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
  });

  test("direction change mid-gesture re-anchors: down-leg after an up-leg signals", () => {
    fire(el, "touchstart", { touches: [{ clientY: 300 }] });
    fire(el, "touchmove", { touches: [{ clientY: 200 }] }); // scrolling down
    fire(el, "touchmove", { touches: [{ clientY: 215 }] }); // reversal: 15px > slop
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
  });

  test("upward keys signal only when the scroller itself has the event target", () => {
    fire(el, "keydown", { key: "PageUp" });
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
    const child = document.createElement("textarea");
    el.appendChild(child);
    fire(child, "keydown", { key: "ArrowUp" }); // composer caret movement
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
  });

  test("scrollbar drag: mouse held + upward scrollTop movement signals", () => {
    el.scrollTop = 500;
    fire(el, "scroll", {}); // settle lastScrollTop
    fire(el, "pointerdown", { pointerType: "mouse" });
    el.scrollTop = 400;
    fire(el, "scroll", {});
    expect(cb.onScrollUpIntent).toHaveBeenCalledTimes(1);
  });

  test("upward scroll without the mouse held (programmatic / reflow) does not signal", () => {
    el.scrollTop = 500;
    fire(el, "scroll", {});
    el.scrollTop = 400;
    fire(el, "scroll", {});
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
  });

  test("mouse released stops the drag interpretation", () => {
    fire(el, "pointerdown", { pointerType: "mouse" });
    fire(window, "pointerup", {});
    el.scrollTop = 500;
    fire(el, "scroll", {});
    el.scrollTop = 400;
    fire(el, "scroll", {});
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
  });

  test("detach removes all listeners", () => {
    detach();
    fire(el, "wheel", { deltaY: -12 });
    fire(el, "touchstart", { touches: [{ clientY: 300 }] });
    expect(cb.onScrollUpIntent).not.toHaveBeenCalled();
    expect(cb.onTouchStart).not.toHaveBeenCalled();
    detach = () => {};
  });
});
