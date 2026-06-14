/**
 * State-machine tests for useChatScroll. jsdom does no layout, so the
 * scroller is a fake element with controlled clientHeight/scrollHeight and
 * the Virtuoso handle is a mock — the tests assert the POLICY:
 *   - break only on user gesture, never on position
 *   - resume only on a not-at-bottom → at-bottom transition (finger up,
 *     no programmatic scroll in flight)
 *   - send anchor: runway sized, mode free, user message scrolled to start
 *   - following pins to the bottom on content growth
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

import { useChatScroll } from "./useChatScroll";
import type { ConversationEntry } from "@pin-ai/core";

function userEntry(id: string): ConversationEntry {
  return { kind: "user", id, ts: 1, text: "hi" };
}
function turnEntry(id: string, running = true): ConversationEntry {
  return { kind: "assistant", id, ts: 1, parts: [], running };
}

function makeScroller(clientHeight = 600) {
  const el = document.createElement("div");
  let scrollHeight = 2000;
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  document.body.appendChild(el);
  return {
    el,
    setScrollHeight(next: number) {
      scrollHeight = next;
    },
  };
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { bubbles: true });
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(e, k, { value: v });
  }
  target.dispatchEvent(e);
}

const flushFrames = (ms = 400) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe("useChatScroll", () => {
  let scroller: ReturnType<typeof makeScroller>;
  let scrollToIndex: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    scroller = makeScroller();
    scrollToIndex = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    scroller.el.remove();
  });

  function setup(initial: ConversationEntry[] = [userEntry("u1"), turnEntry("t1")]) {
    const view = renderHook(
      ({ transcript }) => useChatScroll({ session: "main-1", transcript }),
      { initialProps: { transcript: initial } },
    );
    act(() => {
      view.result.current.handleScrollerRef(scroller.el);
      const ref = view.result.current.virtuosoRef as MutableRefObject<VirtuosoHandle | null>;
      ref.current = { scrollToIndex } as unknown as VirtuosoHandle;
    });
    return view;
  }

  test("pins to the bottom on content growth", () => {
    const { rerender } = setup();
    scroller.setScrollHeight(2400);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames();
    expect(scroller.el.scrollTop).toBe(2400 - 600);
  });

  test("does not pin while the finger is down — a touch owns the scroll", () => {
    const { rerender } = setup();
    scroller.setScrollHeight(2000);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames();
    expect(scroller.el.scrollTop).toBe(2000 - 600); // following → pinned

    // Finger down, then content grows: we must NOT write scrollTop under the
    // touch — writing under the finger/momentum is exactly the iOS bounce.
    act(() => {
      fire(scroller.el, "touchstart", { touches: [{ clientY: 300 }] });
    });
    const held = scroller.el.scrollTop;
    scroller.setScrollHeight(2600);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames();
    expect(scroller.el.scrollTop).toBe(held); // untouched while held

    // Finger up at the bottom: pinning resumes on the next growth.
    act(() => {
      fire(scroller.el, "touchend", { touches: [] });
    });
    scroller.setScrollHeight(2800);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames();
    expect(scroller.el.scrollTop).toBe(2800 - 600);
  });

  test("wheel up breaks following; growth no longer moves the viewport", () => {
    const { result, rerender } = setup();
    act(() => {
      fire(scroller.el, "wheel", { deltaY: -10 });
    });
    expect(result.current.mode).toBe("free");
    const before = scroller.el.scrollTop;
    scroller.setScrollHeight(3000);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames();
    expect(scroller.el.scrollTop).toBe(before);
  });

  test("position changes alone never break following", () => {
    const { result } = setup();
    act(() => {
      result.current.handleAtBottomChange(false); // streaming growth outran the pin
    });
    expect(result.current.mode).toBe("following");
  });

  test("anchorToSend: runway sized to the viewport, mode free, user message scrolled to start", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    // bubble isn't mounted in jsdom → full-viewport fallback minus padding
    expect(result.current.runwayPx).toBe(592);
    expect(result.current.mode).toBe("free");
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, align: "start" }),
    );
  });

  test("the anchor's own arrival at the bottom does not resume following", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    act(() => {
      result.current.handleAtBottomChange(false);
      result.current.handleAtBottomChange(true); // programmatic scroll landing
    });
    expect(result.current.mode).toBe("free");
  });

  test("reaching the still-open runway's blank bottom does not resume or collapse it", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames(); // programmatic window settles
    const runway = result.current.runwayPx;
    expect(runway).toBeGreaterThan(1);
    // The reply hasn't filled the viewport, so the runway is still open and the
    // "bottom" is just blank space. Returning to it must NOT collapse the runway
    // in one jump (the old bug) — stay free, runway untouched.
    act(() => {
      result.current.handleAtBottomChange(false);
      result.current.handleAtBottomChange(true);
    });
    expect(result.current.mode).toBe("free");
    expect(result.current.runwayPx).toBe(runway);
  });

  test("the free runway shrinks as the reply grows (no jump), then resumes once consumed", () => {
    const { result, rerender } = setup([userEntry("u1")]);
    // Mount the anchor bubble pinned at the content top (scrollTop 0) so the
    // runway can be re-measured against it. jsdom does no layout, so rects and
    // scrollHeight are mocked to drive the formula directly.
    const anchor = document.createElement("div");
    anchor.setAttribute("data-entry-id", "u1");
    scroller.el.appendChild(anchor);
    const rect = (top: number) =>
      ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
    scroller.el.getBoundingClientRect = () => rect(0);
    anchor.getBoundingClientRect = () => rect(0);
    scroller.el.scrollTop = 0;

    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    flushFrames(); // settle the anchor scroll's programmatic window
    expect(result.current.runwayPx).toBeGreaterThan(1); // runway opened

    // Reply grows: content below the anchor goes to 300. The runway shrinks by
    // the same 300 so scrollHeight (= content + runway) and scrollTop hold.
    scroller.setScrollHeight(300 + result.current.runwayPx);
    act(() => result.current.handleTotalHeightChange());
    flushFrames();
    expect(result.current.runwayPx).toBe(600 - 300 - 8);
    expect(scroller.el.scrollTop).toBe(0); // zero jump

    // Reply overflows the viewport — the runway bottoms out at 0.
    scroller.setScrollHeight(700 + result.current.runwayPx);
    act(() => result.current.handleTotalHeightChange());
    flushFrames();
    expect(result.current.runwayPx).toBe(0);
    expect(scroller.el.scrollTop).toBe(0);

    // The true tail now sits at the bottom: returning there resumes follow, and
    // collapsing an already-0 runway is a no-op.
    act(() => {
      result.current.handleAtBottomChange(false);
      result.current.handleAtBottomChange(true);
    });
    expect(result.current.mode).toBe("following");
  });

  test("a smooth anchor animation outliving the settle window stays programmatic (scroll events re-arm it)", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    // The animation emits scroll events past the 160ms one-shot window —
    // each one re-arms the settle timer, so the window must still be up.
    for (let t = 0; t < 4; t++) {
      act(() => {
        vi.advanceTimersByTime(100);
        fire(scroller.el, "scroll", {});
      });
    }
    act(() => {
      result.current.handleAtBottomChange(false);
      result.current.handleAtBottomChange(true); // the animation landing at the bottom
    });
    expect(result.current.mode).toBe("free"); // NOT mistaken for the user
    // After real scroll silence the programmatic gate releases — but the runway
    // gate is independent: the runway is still open, so a return to its blank
    // bottom still must not resume (resume waits for the runway to be consumed,
    // covered by the shrink test above).
    flushFrames(300);
    act(() => {
      result.current.handleAtBottomChange(false);
      result.current.handleAtBottomChange(true);
    });
    expect(result.current.mode).toBe("free");
  });

  test("resume waits for the finger to lift", () => {
    const { result } = setup();
    act(() => {
      fire(scroller.el, "wheel", { deltaY: -10 }); // free
      result.current.handleAtBottomChange(false);
    });
    flushFrames();
    act(() => {
      fire(scroller.el, "touchstart", { touches: [{ clientY: 300 }] });
      result.current.handleAtBottomChange(true); // dragged to bottom, still holding
    });
    expect(result.current.mode).toBe("free");
    act(() => {
      fire(scroller.el, "touchend", { touches: [] });
    });
    expect(result.current.mode).toBe("following");
  });

  test("jumpToLatest follows, collapses the runway and jumps to LAST", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.anchorToSend();
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] });
    expect(result.current.runwayPx).toBeGreaterThan(0);
    act(() => {
      result.current.jumpToLatest();
    });
    expect(result.current.mode).toBe("following");
    expect(result.current.runwayPx).toBe(0);
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: "LAST", align: "end" }),
    );
  });

  test("showJump mirrors at-bottom; new tail below the fold pulses hasNewBelow", () => {
    const { result, rerender } = setup();
    act(() => {
      fire(scroller.el, "wheel", { deltaY: -10 }); // free
      result.current.handleAtBottomChange(false);
    });
    expect(result.current.showJump).toBe(true);
    rerender({ transcript: [userEntry("u1"), turnEntry("t1", false), turnEntry("t2")] });
    expect(result.current.hasNewBelow).toBe(true);
    act(() => {
      result.current.jumpToLatest();
    });
    expect(result.current.hasNewBelow).toBe(false);
    act(() => {
      result.current.handleAtBottomChange(true);
    });
    expect(result.current.showJump).toBe(false);
  });

  test("in-place turn growth (same tail id) does not pulse hasNewBelow", () => {
    const { result, rerender } = setup();
    act(() => {
      fire(scroller.el, "wheel", { deltaY: -10 });
      result.current.handleAtBottomChange(false);
    });
    rerender({ transcript: [userEntry("u1"), turnEntry("t1")] }); // delta flush
    expect(result.current.hasNewBelow).toBe(false);
  });

  test("conversation switch resets to following with no runway", () => {
    const view = renderHook(
      ({ session, transcript }: { session: string; transcript: ConversationEntry[] }) =>
        useChatScroll({ session, transcript }),
      { initialProps: { session: "main-1", transcript: [userEntry("u1")] } },
    );
    act(() => {
      view.result.current.handleScrollerRef(scroller.el);
      fire(scroller.el, "wheel", { deltaY: -10 });
    });
    expect(view.result.current.mode).toBe("free");
    view.rerender({ session: "card-thread-9", transcript: [] });
    expect(view.result.current.mode).toBe("following");
    expect(view.result.current.runwayPx).toBe(0);
  });
});
