/**
 * useChatScroll — the single owner of transcript scroll policy.
 *
 * Reading-first model (Claude/ChatGPT-style), as one explicit state machine:
 *
 *   mode: "following"  the viewport re-pins to the bottom as content grows —
 *                      ONE write per change, never a per-frame animation (a
 *                      main-thread animation races iOS momentum and bounces).
 *                      Suppressed while the finger is down, so a streaming reply
 *                      sticks without fighting the user (assistant-ui's pattern).
 *   mode: "free"       the viewport never moves on its own. The default
 *                      after sending: the user's message is anchored to the
 *                      viewport top and the reply streams into a runway
 *                      (a footer spacer) below it, so the reading position is
 *                      perfectly still. The runway shrinks by exactly the
 *                      reply's growth — scrollHeight stays constant, so there
 *                      is zero jump — and reaches 0 once the reply fills a
 *                      viewport (from then on the reply grows the true tail).
 *
 * Transitions (asymmetric on purpose — this kills the two classic streaming
 * scroll bugs):
 *   - BREAK  following → free only on a user input gesture (wheel up, touch
 *     drag up, PageUp/Home, scrollbar drag up — see scroll-intent.ts). Never
 *     on a position heuristic: position checks race streaming growth, which
 *     is exactly how virtuoso's built-in follow both fought the user
 *     (SIZE_INCREASED outranking SCROLLING_UPWARDS) and silently slipped.
 *   - RESUME free → following only on a not-at-bottom → at-bottom TRANSITION
 *     (the user deliberately came back), with the finger lifted, no
 *     programmatic scroll in flight, AND the runway already consumed (== 0).
 *     That last clause is what kills the "collapse jump": while the runway is
 *     open the bottom is just blank space, so reaching it must NOT resume;
 *     only once the reply has eaten the runway does the true tail sit at the
 *     bottom — and collapsing an already-0 runway is a no-op.
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

import { attachScrollIntentListeners } from "./scroll-intent";
import type { ConversationEntry } from "@pin-ai/core";

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
  virtuosoRef: RefObject<VirtuosoHandle | null>;
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
  const runwayPxRef = useRef(0);
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
  const adjustRafRef = useRef<number | null>(null);
  // Send anchor choreography state: "runway" sizes the spacer, the follow-up
  // pass scrolls. Each phase bumps anchorTick so the effect below is
  // GUARANTEED a re-run even when no other state happens to change (e.g. two
  // identical sends in a row leave runway/mode untouched).
  const pendingAnchorRef = useRef<null | { phase: "runway" | "scroll" }>(null);
  const [anchorTick, setAnchorTick] = useState(0);
  const prevTailIdRef = useRef<string | null>(null);
  // The user message the runway is sized against. Set when a send anchors;
  // cleared when follow re-engages (the runway's life ends with free mode).
  // While set and in free mode, the runway is re-measured against this bubble
  // on every content/viewport change so it shrinks as the reply grows.
  const anchorIdRef = useRef<string | null>(null);

  const setModeBoth = useCallback((next: ScrollMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  const setRunwayBoth = useCallback((next: number) => {
    runwayPxRef.current = next;
    setRunwayPx(next);
  }, []);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      programmaticRef.current = false;
      settleTimerRef.current = null;
    }, PROGRAMMATIC_SETTLE_MS);
  }, []);

  /** Pin the viewport to the bottom (following only) — ONE write, never a
   *  per-frame animation: hand the scroll to the browser's one-shot path
   *  instead of racing iOS momentum on the main thread (the spring's mistake).
   *  Suppressed while the finger is down — a user touch owns the scroll, so we
   *  never write under it (mirrors assistant-ui cancelling on pointerdown). */
  const pinBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || modeRef.current !== "following" || touchActiveRef.current) return;
    markProgrammatic();
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, [markProgrammatic]);

  /**
   * Keep the viewport coherent with content/runway growth (one coalesced rAF):
   *   - following: pin to the bottom (pinBottom) — a single write, suppressed
   *     under touch, so a streaming reply sticks without fighting the user.
   *   - free + an active send anchor: shrink the runway to exactly absorb the
   *     reply. runway = max(0, viewport − belowAnchor − pad), where belowAnchor
   *     is the height from the anchored user bubble's top to the real content
   *     bottom (runway excluded). As the reply grows, belowAnchor grows and the
   *     runway shrinks by the same amount, so scrollHeight (= viewport +
   *     anchorTop − pad) is constant and scrollTop never moves — zero jump. The
   *     formula is absolute (re-derived from layout), so it self-corrects.
   * The free branch is skipped while a send choreography or programmatic scroll
   * is in flight — the anchor bubble isn't settled at the top yet.
   */
  const scheduleAdjust = useCallback(() => {
    if (adjustRafRef.current !== null) return;
    adjustRafRef.current = requestAnimationFrame(() => {
      adjustRafRef.current = null;
      const el = scrollerRef.current;
      if (!el) return;
      if (modeRef.current === "following") {
        pinBottom();
        return;
      }
      const anchorId = anchorIdRef.current;
      if (!anchorId || pendingAnchorRef.current || programmaticRef.current) return;
      const anchor = el.querySelector(`[data-entry-id="${anchorId}"]`);
      if (!(anchor instanceof HTMLElement)) return; // not mounted — hold the runway
      const viewport = el.clientHeight;
      const anchorTop =
        anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const contentBottom = el.scrollHeight - runwayPxRef.current; // real content, runway excluded
      const belowAnchor = contentBottom - anchorTop;
      const next = Math.max(0, viewport - belowAnchor - ANCHOR_TOP_PAD_PX);
      if (next !== runwayPxRef.current) setRunwayBoth(next);
    });
  }, [pinBottom, setRunwayBoth]);

  const engageFollowing = useCallback(() => {
    anchorIdRef.current = null; // the runway's life ends when follow re-engages
    setModeBoth("following");
    setRunwayBoth(0); // follow wants the true tail — the runway blank is over
    setHasNewBelow(false);
    // No immediate scrollTop write: re-engaging usually happens AS momentum
    // carries the view to the bottom, and writing into a live iOS fling is the
    // bounce. Just arm following — the next content growth (or keyboard resize)
    // pins via scheduleAdjust, by which point the fling has settled. (The user
    // is already at the bottom here, so there's nothing to catch up to anyway.)
  }, [setModeBoth, setRunwayBoth]);

  const breakFollowing = useCallback(() => {
    if (modeRef.current !== "following") return;
    if (adjustRafRef.current !== null) {
      cancelAnimationFrame(adjustRafRef.current);
      adjustRafRef.current = null;
    }
    setModeBoth("free");
  }, [setModeBoth]);

  const maybeResume = useCallback(() => {
    if (
      modeRef.current === "free"
      && atBottomRef.current
      && !touchActiveRef.current
      && !programmaticRef.current
      // Only when the runway is consumed: while it's open the "bottom" is just
      // blank space, and resuming there would collapse the runway in one jump.
      && runwayPxRef.current <= 1
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
      // expand, browser mini-sheet. Following: re-pin to the tail. Free with an
      // anchor: re-measure the runway (a shorter viewport needs less runway).
      // The browser keeps scrollTop, so the top-anchored reading position holds.
      viewportObserverRef.current = new ResizeObserver(() => scheduleAdjust());
      viewportObserverRef.current.observe(el);
    },
    [breakFollowing, maybeResume, scheduleAdjust, markProgrammatic],
  );
  useEffect(
    () => () => {
      detachIntentRef.current?.();
      viewportObserverRef.current?.disconnect();
      if (adjustRafRef.current !== null) cancelAnimationFrame(adjustRafRef.current);
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

  const handleTotalHeightChange = useCallback(() => scheduleAdjust(), [scheduleAdjust]);

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
      anchorIdRef.current = transcript[userIdx].id;
      setRunwayBoth(Math.max(0, viewport - bubbleH - ANCHOR_TOP_PAD_PX));
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
  }, [transcript, anchorTick, setModeBoth, setRunwayBoth, markProgrammatic]);

  // Conversation switch — back to the entry state (Virtuoso remounts via the
  // ready/empty gates and lands at the bottom on its own). Declared BEFORE the
  // content-change effect so the same-commit order is reset-then-record: the
  // new conversation's first fill is recorded as the baseline, not pulsed.
  useEffect(() => {
    pendingAnchorRef.current = null;
    anchorIdRef.current = null;
    setModeBoth("following");
    setRunwayBoth(0);
    setHasNewBelow(false);
    atBottomRef.current = true;
    setAtBottom(true);
    prevTailIdRef.current = null;
    touchActiveRef.current = false;
    programmaticRef.current = false;
  }, [session, setModeBoth, setRunwayBoth]);

  // Content changes: re-pin (following) / re-measure the runway (free) and
  // surface "new below" when reading.
  useEffect(() => {
    scheduleAdjust();
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
  }, [transcript, scheduleAdjust]);

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
