/**
 * User scroll-intent detection for the conversation transcript.
 *
 * The transcript's follow/free state machine (useChatScroll) must tell
 * USER-initiated scrolling apart from programmatic scrolls and streaming
 * content growth. Raw input events (wheel / touch / keys) are inherently
 * user-initiated, so upward intent is derived from them — never from
 * `scroll` events, which also fire for programmatic scrolls and reflows.
 * That asymmetry is the core fix for the "auto-follow fights the user"
 * class of bugs: a position heuristic races content growth; an input
 * event cannot.
 *
 * The one input that produces no wheel/touch events is dragging the
 * scrollbar with a mouse. It's covered by pairing a mouse pointerdown on
 * the scroller with subsequent upward scrollTop movement — our own
 * programmatic scrolls only ever move DOWN (pin to bottom), so an upward
 * move while the mouse is held is always the user.
 */

/** Finger travel (px) before a touch drag counts as upward intent —
 *  filters out tap jitter without delaying a real drag. */
const TOUCH_DRAG_SLOP_PX = 8;

export interface ScrollIntentCallbacks {
  /** Any upward scroll intent — the state machine breaks follow mode. */
  onScrollUpIntent: () => void;
  /** Touch lifecycle — position-based follow resume waits for release. */
  onTouchStart: () => void;
  onTouchEnd: () => void;
}

/** Keys that scroll a focused scroller upward. */
const UPWARD_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

export function attachScrollIntentListeners(
  el: HTMLElement,
  cb: ScrollIntentCallbacks,
): () => void {
  let touchAnchorY: number | null = null;
  let mouseDragging = false;
  let lastScrollTop = el.scrollTop;

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return; // trackpad pinch-zoom, not a scroll
    if (e.deltaY < 0) cb.onScrollUpIntent();
  };

  const onTouchStart = (e: TouchEvent) => {
    touchAnchorY = e.touches[0]?.clientY ?? null;
    cb.onTouchStart();
  };

  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (y === undefined || touchAnchorY === null) return;
    // Finger moving DOWN the screen scrolls the content UP.
    if (y - touchAnchorY > TOUCH_DRAG_SLOP_PX) {
      cb.onScrollUpIntent();
      touchAnchorY = y; // re-anchor so a long drag keeps signalling
    } else if (y < touchAnchorY) {
      touchAnchorY = y; // direction change — measure the next leg fresh
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    // Multi-touch: the gesture only ends when the LAST finger lifts.
    if (e.touches.length > 0) {
      touchAnchorY = e.touches[0].clientY;
      return;
    }
    touchAnchorY = null;
    cb.onTouchEnd();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Only when the scroller itself owns focus — ArrowUp in the composer
    // textarea is caret movement, not scrolling.
    if (e.target === el && UPWARD_KEYS.has(e.key)) cb.onScrollUpIntent();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") {
      mouseDragging = true;
      lastScrollTop = el.scrollTop;
    }
  };
  // pointerup on window (the drag may end outside the scroller) +
  // pointercancel so an OS-interrupted drag can't leave the flag stuck.
  const onPointerUp = () => {
    mouseDragging = false;
  };

  const onScroll = () => {
    const top = el.scrollTop;
    // Scrollbar drag (mouse held): upward movement is always the user.
    if (mouseDragging && top < lastScrollTop) cb.onScrollUpIntent();
    lastScrollTop = top;
  };

  el.addEventListener("wheel", onWheel, { passive: true });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: true });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true });
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  window.addEventListener("pointercancel", onPointerUp, { passive: true });
  el.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("scroll", onScroll);
  };
}
