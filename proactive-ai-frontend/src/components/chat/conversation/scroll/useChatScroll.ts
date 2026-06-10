/**
 * useChatScroll — the single owner of transcript scroll policy.
 *
 * Reading-first model (Claude/ChatGPT-style), as one explicit state machine:
 *
 *   mode: "following"  the viewport sticks to the bottom; every content
 *                      growth re-pins (rAF-throttled, instant behavior).
 *   mode: "free"       the viewport never moves on its own. The default
 *                      after sending: the user's message is anchored to the
 *                      viewport top and the reply streams into the runway
 *                      below it, so the reading position is perfectly still.
 *
 * Transitions (asymmetric on purpose — this kills the two classic streaming
 * scroll bugs):
 *   - BREAK  following → free only on a user input gesture (wheel up, touch
 *     drag up, PageUp/Home, scrollbar drag up — see scroll-intent.ts). Never
 *     on a position heuristic: position checks race streaming growth, which
 *     is exactly how virtuoso's built-in follow both fought the user
 *     (SIZE_INCREASED outranking SCROLLING_UPWARDS) and silently slipped.
 *   - RESUME free → following only on a not-at-bottom → at-bottom TRANSITION
 *     (the user deliberately came back), with the finger lifted and no
 *     programmatic scroll in flight. The anchored reading position sits AT
 *     the bottom (the runway absorbs growth), so it never produces such a
 *     transition and reading is never hijacked.
 *   - jumpToLatest()  explicit: collapse the runway, pin, follow.
 *   - anchorToSend()  send choreography: size the runway, scroll the new
 *     user message to the viewport top, land in free mode.
 *
 * Virtuoso is demoted to a pure virtualized list (followOutput={false});
 * every programmatic scroll in the conversation flows through this hook.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

import { attachScrollIntentListeners } from "@/components/chat/conversation/scroll/scroll-intent";
import type { ConversationEntry } from "@/components/chat/conversation/useConversationRuntime";

export type ScrollMode = "following" | "free";

/** Breathing room kept above the anchored user bubble (px). */
const ANCHOR_TOP_PAD_PX = 8;
/** A programmatic smooth scroll is considered settled after this much
 *  scroll-event silence. */
const PROGRAMMATIC_SETTLE_MS = 160;
/** Anchor scrolls farther than this many viewports jump instantly —
 *  a long smooth animation reads as lag, not polish. */
const SMOOTH_MAX_VIEWPORTS = 2;

interface UseChatScrollOptions {
  /** Conversation identity — mode/runway reset when it changes. */
  session: string;
  transcript: ConversationEntry[];
}

export interface ChatScrollApi {
  virtuosoRef: RefObject<VirtuosoHandle>;
  mode: ScrollMode;
  /** Footer spacer height — the runway the streaming reply grows into. */
  runwayPx: number;
  /** Show the jump-to-latest affordance (not at bottom). */
  showJump: boolean;
  /** New entries landed below the fold while reading — pulse the affordance. */
  hasNewBelow: boolean;
  /** Virtuoso `scrollerRef` — wires gesture/viewport listeners. */
  handleScrollerRef: (el: HTMLElement | Window | null) => void;
  /** Virtuoso `atBottomStateChange`. */
  handleAtBottomChange: (atBottom: boolean) => void;
  /** Virtuoso `totalListHeightChanged` — content growth re-pin signal. */
  handleTotalHeightChange: () => void;
  /** Jump to the live tail and follow it. */
  jumpToLatest: () => void;
  /** Call right after the runtime appended the optimistic user bubble. */
  anchorToSend: () => void;
}

export function useChatScroll({ session, transcript }: UseChatScrollOptions): ChatScrollApi {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const [mode, setMode] = useState<ScrollMode>("following");
  const modeRef = useRef<ScrollMode>("following");
  const [runwayPx, setRunwayPx] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);

  const touchActiveRef = useRef(false);
  // True while one of OUR scrolls is in flight. Suppresses the resume rule so
  // the anchor animation's own arrival at the bottom can't be mistaken for
  // the user coming back. A smooth scroll outlives any fixed timeout, so the
  // window is kept alive by the scroll events themselves (a listener in
  // handleScrollerRef re-arms the settle timer on every scroll while the
  // flag is up) and expires only after PROGRAMMATIC_SETTLE_MS of silence.
  const programmaticRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const pinRafRef = useRef<number | null>(null);
  // Send anchor choreography state: "runway" sizes the spacer, the follow-up
  // pass scrolls. Each phase bumps anchorTick so the effect below is
  // GUARANTEED a re-run even when no other state happens to change (e.g. two
  // identical sends in a row leave runway/mode untouched).
  const pendingAnchorRef = useRef<null | { phase: "runway" | "scroll" }>(null);
  const [anchorTick, setAnchorTick] = useState(0);
  const prevTailIdRef = useRef<string | null>(null);

  const setModeBoth = useCallback((next: ScrollMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      programmaticRef.current = false;
      settleTimerRef.current = null;
    }, PROGRAMMATIC_SETTLE_MS);
  }, []);

  /** Pin the viewport to the bottom on the next frame (idempotent). */
  const schedulePin = useCallback(() => {
    if (modeRef.current !== "following") return;
    if (pinRafRef.current !== null) return;
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = null;
      if (modeRef.current !== "following") return;
      const el = scrollerRef.current;
      if (!el) return;
      markProgrammatic();
      el.scrollTop = el.scrollHeight;
    });
  }, [markProgrammatic]);

  const engageFollowing = useCallback(() => {
    setModeBoth("following");
    setRunwayPx(0); // follow wants the true tail — the runway blank is over
    setHasNewBelow(false);
    schedulePin();
  }, [setModeBoth, schedulePin]);

  const breakFollowing = useCallback(() => {
    if (modeRef.current !== "following") return;
    if (pinRafRef.current !== null) {
      cancelAnimationFrame(pinRafRef.current);
      pinRafRef.current = null;
    }
    setModeBoth("free");
  }, [setModeBoth]);

  const maybeResume = useCallback(() => {
    if (
      modeRef.current === "free"
      && atBottomRef.current
      && !touchActiveRef.current
      && !programmaticRef.current
    ) {
      engageFollowing();
    }
  }, [engageFollowing]);

  // ── virtuoso + DOM wiring ──
  const detachIntentRef = useRef<(() => void) | null>(null);
  const viewportObserverRef = useRef<ResizeObserver | null>(null);
  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      detachIntentRef.current?.();
      detachIntentRef.current = null;
      viewportObserverRef.current?.disconnect();
      viewportObserverRef.current = null;
      // A scroller swap loses any in-flight gesture's end events — don't
      // let a stale "finger down" block resume forever.
      touchActiveRef.current = false;
      if (!(el instanceof HTMLElement)) {
        scrollerRef.current = null;
        return;
      }
      scrollerRef.current = el;
      const detachIntent = attachScrollIntentListeners(el, {
        onScrollUpIntent: breakFollowing,
        onTouchStart: () => {
          touchActiveRef.current = true;
        },
        onTouchEnd: () => {
          touchActiveRef.current = false;
          // Dragged to the bottom and released → the transition already
          // fired during the touch; re-check now that the finger is up.
          maybeResume();
        },
      });
      // Keep the programmatic window alive for the WHOLE smooth-anchor
      // animation: every scroll event while the flag is up re-arms the
      // settle timer, so it expires only after real scroll silence. Without
      // this, a fixed window dies mid-animation and the animation's own
      // landing at the bottom would be read as the user resuming follow.
      const onScrollSettle = () => {
        if (programmaticRef.current) markProgrammatic();
      };
      el.addEventListener("scroll", onScrollSettle, { passive: true });
      detachIntentRef.current = () => {
        detachIntent();
        el.removeEventListener("scroll", onScrollSettle);
      };
      // Viewport (clientHeight) changes — keyboard show/hide, TodoPanel
      // expand, browser mini-sheet — re-pin when following. In free mode the
      // browser keeps scrollTop, so the top-anchored reading position holds.
      viewportObserverRef.current = new ResizeObserver(() => schedulePin());
      viewportObserverRef.current.observe(el);
    },
    [breakFollowing, maybeResume, schedulePin, markProgrammatic],
  );
  useEffect(
    () => () => {
      detachIntentRef.current?.();
      viewportObserverRef.current?.disconnect();
      if (pinRafRef.current !== null) cancelAnimationFrame(pinRafRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const handleAtBottomChange = useCallback(
    (next: boolean) => {
      atBottomRef.current = next;
      setAtBottom(next);
      if (next) {
        setHasNewBelow(false);
        // The not-at-bottom → at-bottom TRANSITION is the resume signal.
        maybeResume();
      }
    },
    [maybeResume],
  );

  const handleTotalHeightChange = useCallback(() => schedulePin(), [schedulePin]);

  // ── commands ──
  const jumpToLatest = useCallback(() => {
    const count = transcript.length;
    engageFollowing();
    markProgrammatic();
    if (count > 0) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
  }, [transcript.length, engageFollowing, markProgrammatic]);

  const anchorToSend = useCallback(() => {
    pendingAnchorRef.current = { phase: "runway" };
    // The effect below completes the choreography once the optimistic
    // bubble is in the transcript (same React batch as the send).
    setAnchorTick((t) => t + 1);
  }, []);

  // Send-anchor choreography. Phase "runway": size the Footer spacer so the
  // content below the new user message can fill a viewport — the anchor
  // position becomes reachable, and from then on the reply only ever grows
  // BELOW the viewport, which never moves scrollTop. The anchored reading
  // position is layout-stable by construction. Phase "scroll": after the
  // spacer commits, scroll the user message to the viewport top.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    let userIdx = -1;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].kind === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return; // bubble not committed yet — next pass picks it up
    if (pending.phase === "runway") {
      const el = scrollerRef.current;
      const viewport = el?.clientHeight ?? 0;
      // Measure the just-rendered bubble; when it isn't mounted (sent from
      // deep in history) fall back to a full-viewport runway — over-
      // provisioning only adds blank space below the fold, never breaks the
      // anchor, while under-provisioning would clamp the scroll short.
      const bubble = el?.querySelector(`[data-entry-id="${transcript[userIdx].id}"]`);
      const bubbleH = bubble instanceof HTMLElement ? bubble.offsetHeight : 0;
      setRunwayPx(Math.max(0, viewport - bubbleH - ANCHOR_TOP_PAD_PX));
      setModeBoth("free");
      setHasNewBelow(false);
      pending.phase = "scroll";
      setAnchorTick((t) => t + 1); // re-run after the runway spacer commits
      return;
    }
    pendingAnchorRef.current = null;
    const el = scrollerRef.current;
    const farJump =
      el !== null
      && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * SMOOTH_MAX_VIEWPORTS;
    markProgrammatic();
    virtuosoRef.current?.scrollToIndex({
      index: userIdx,
      align: "start",
      // The negative offset is what actually leaves the breathing room: the
      // runway is over-provisioned by the same pad, so without it the bubble
      // would sit flush against the viewport top.
      offset: -ANCHOR_TOP_PAD_PX,
      behavior: farJump ? "auto" : "smooth",
    });
  }, [transcript, anchorTick, setModeBoth, markProgrammatic]);

  // Conversation switch — back to the entry state (Virtuoso remounts via the
  // ready/empty gates and lands at the bottom on its own). Declared BEFORE the
  // content-change effect so the same-commit order is reset-then-record: the
  // new conversation's first fill is recorded as the baseline, not pulsed.
  useEffect(() => {
    pendingAnchorRef.current = null;
    setModeBoth("following");
    setRunwayPx(0);
    setHasNewBelow(false);
    atBottomRef.current = true;
    setAtBottom(true);
    prevTailIdRef.current = null;
    touchActiveRef.current = false;
    programmaticRef.current = false;
  }, [session, setModeBoth]);

  // Content changes: re-pin when following; surface "new below" when reading.
  useEffect(() => {
    schedulePin();
    const tail = transcript.length > 0 ? transcript[transcript.length - 1] : null;
    const tailId = tail?.id ?? null;
    if (
      tailId !== prevTailIdRef.current
      && prevTailIdRef.current !== null
      && modeRef.current === "free"
      && !atBottomRef.current
      && !pendingAnchorRef.current
    ) {
      setHasNewBelow(true);
    }
    prevTailIdRef.current = tailId;
  }, [transcript, schedulePin]);

  const showJump = !atBottom && transcript.length > 0;

  return useMemo(
    () => ({
      virtuosoRef,
      mode,
      runwayPx,
      showJump,
      hasNewBelow,
      handleScrollerRef,
      handleAtBottomChange,
      handleTotalHeightChange,
      jumpToLatest,
      anchorToSend,
    }),
    [
      mode,
      runwayPx,
      showJump,
      hasNewBelow,
      handleScrollerRef,
      handleAtBottomChange,
      handleTotalHeightChange,
      jumpToLatest,
      anchorToSend,
    ],
  );
}
