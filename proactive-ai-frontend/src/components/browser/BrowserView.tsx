import {
  useEffect,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Loader2,
  Hand,
  Bot,
  ChevronDown,
  ChevronUp,
  X,
  AlertCircle,
  Keyboard,
  Plus,
  Minus,
  CornerDownLeft,
  GripHorizontal,
} from "lucide-react";

export type SheetStage = "mini" | "medium" | "full";

interface BrowserViewProps {
  liveViewUrl: string;
  sessionId: string;
  controlMode: "ai" | "user" | "idle";
  takeoverReason?: string | null;
  /** Bumped by the parent on foreground/visibility events to force the
   *  iframe to remount — works around iOS pausing the Browserbase WebSocket
   *  while the app was backgrounded, leaving the iframe blank. */
  iframeReloadKey?: number;
  sheetStage: SheetStage;
  isNative: boolean;
  /** Remote page viewport in CSS px — for mobile/tablet sessions this is
   *  matched to the user's panel width, so the iframe renders 1:1; for
   *  desktop (1280×800 preset) we fit-to-height with horizontal scroll. */
  viewport: { width: number; height: number };
  /** Device profile the BB session was launched with. "mobile"/"tablet"
   *  → fit-to-width (vertical scroll inside iframe is the native mobile
   *  pattern); "desktop" → fit-to-height (full chrome visible, page
   *  exceeds panel width and the wrapper scrolls horizontally). */
  deviceKind: "mobile" | "tablet" | "desktop";
  onUserInputText: (text: string) => Promise<void>;
  onUserInputKey: (key: string) => Promise<void>;
  onUserInputClick: (x: number, y: number) => Promise<void>;
  onUserInputScroll: (dx: number, dy: number) => Promise<void>;
  onControlChange: (mode: "ai" | "user") => void;
  onCycleStage: () => void;
  onRequestClose: () => void;
  onChromePointerDown: (e: ReactPointerEvent) => void;
}

/** Tap distance threshold (CSS px in panel coords). */
const TAP_THRESHOLD_PX = 8;

/** Browserbase debuggerFullscreenUrl renders its own desktop browser chrome
 *  (URL bar + back/forward/reload) at the top of the iframe, ~40 CSS px tall.
 *  Add this to the iframe's layout height so the remote viewport (1280×800)
 *  isn't squeezed by the chrome. fit-to-height scale uses this combined value. */
const BROWSERBASE_CHROME_HEIGHT = 40;

export default function BrowserView({
  liveViewUrl,
  sessionId,
  controlMode,
  takeoverReason,
  iframeReloadKey = 0,
  sheetStage,
  isNative,
  viewport,
  deviceKind,
  onUserInputText,
  onUserInputKey,
  onUserInputClick,
  onUserInputScroll,
  onControlChange,
  onCycleStage,
  onRequestClose,
  onChromePointerDown,
}: BrowserViewProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // Synchronize the iframe-content reveal with the appearance of the
  // floating user-control buttons (Zoom +/- + drag-pad), which are gated
  // on `controlMode === "user"`. Without this, the iframe HTML loads
  // (`onLoad` fires `iframeLoaded=true`) some time BEFORE the agent's
  // follow-up `request_takeover` flips controlMode → "user" — the user
  // sees the page first, then the buttons pop in a beat later, which
  // reads as jank. Hiding the iframe behind the loading overlay until
  // BOTH (a) the HTML has loaded AND (b) the backend has confirmed
  // user takeover makes both surfaces reveal in the same frame.
  //
  // Fallback: if takeover never arrives (e.g. an AI-driven browse with
  // no user takeover step), we expose the iframe anyway after a short
  // grace window so the user isn't stuck on "Loading browser..." forever.
  const [sessionReady, setSessionReady] = useState(false);
  useEffect(() => {
    if (!iframeLoaded) {
      setSessionReady(false);
      return;
    }
    if (controlMode === "user") {
      setSessionReady(true);
      return;
    }
    const t = window.setTimeout(() => setSessionReady(true), 2500);
    return () => window.clearTimeout(t);
  }, [iframeLoaded, controlMode]);

  const isMini = sheetStage === "mini";
  const stopDrag = (e: ReactPointerEvent) => e.stopPropagation();

  // Measure the iframe wrapper so we can compute fit-to-height transform
  // scale that maps remote 1280×800 layout onto the panel without leaving
  // a vertical black band at the bottom.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [wrapperSize, setWrapperSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      // Skip 0-sized measurements (mini stage collapses the wrapper to
      // h-0). Keeping the last good value prevents fitScale → 0 → giant
      // ResizeObserver churn when transitioning back to medium/full,
      // which made the panel feel frozen and unresponsive to drag.
      if (w === 0 || h === 0) return;
      setWrapperSize({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMini]);

  // Fit strategy depends on the remote device profile:
  //   - mobile / tablet: "contain" fit — pick the smaller of width-fit
  //     and height-fit so nothing clips. When the BB viewport was sized
  //     to the panel CSS px (the common case) both ratios are ~1.0 and
  //     the iframe renders 1:1. When they diverge (stage change, hint
  //     mismatch) the page downscales rather than getting cut off.
  //   - desktop: fit-to-height with horizontal scroll. Keeps Browserbase's
  //     own chrome (URL bar / back / forward / reload) visible without
  //     squeezing; the wrapper scrolls horizontally — default the scroll
  //     position to centered so most pages' main content is in view.
  const layoutH = viewport.height + BROWSERBASE_CHROME_HEIGHT;
  const fitToWidth = deviceKind !== "desktop";
  const fitScale =
    wrapperSize.w > 0 && wrapperSize.h > 0
      ? fitToWidth
        ? Math.min(wrapperSize.w / viewport.width, wrapperSize.h / layoutH)
        : wrapperSize.h / layoutH
      : 1;
  const [userZoom, setUserZoom] = useState(1);
  const isZoomedIn = userZoom > 1.05;
  const scale = fitScale * userZoom;
  const visualW = viewport.width * scale;
  const visualH = layoutH * scale;

  // Default scrollLeft to center on first measure / new session. Only
  // meaningful for the desktop fit (the wrapper is horizontally
  // scrollable there); mobile/tablet fit clips at panel width.
  const sessionRef = useRef<string>("");
  useEffect(() => {
    if (fitToWidth) return;
    const el = wrapperRef.current;
    if (!el) return;
    if (visualW <= 0 || wrapperSize.w <= 0) return;
    if (sessionRef.current === sessionId && el.scrollLeft !== 0) return;
    sessionRef.current = sessionId;
    const target = Math.max(0, (visualW - wrapperSize.w) / 2);
    el.scrollLeft = target;
  }, [sessionId, visualW, wrapperSize.w, fitToWidth]);

  // Mini stage entry → reset zoom and horizontal scroll. Without this, a
  // user who zoomed before collapsing to mini comes back to a giant
  // off-center visual on expand, plus React thrashes through several
  // ResizeObserver-driven re-renders that lock up the drag handle.
  useEffect(() => {
    if (!isMini) return;
    setUserZoom(1);
    if (wrapperRef.current) wrapperRef.current.scrollLeft = 0;
  }, [isMini]);

  // Hidden input that summons the iOS keyboard when the user taps the
  // explicit Keyboard button. Each char is forwarded to whatever element
  // the remote chromium currently has focused.
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  // Mirror Capacitor's keyboardWillShow / keyboardWillHide (dispatched as
  // window events from main.tsx) so the ⌨️ button can flip between
  // "summon keyboard" and "dismiss keyboard" — without it the user has
  // to tap iframe to blur the hidden input.
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const show = () => setKbVisible(true);
    const hide = () => setKbVisible(false);
    window.addEventListener("pinai:kbShow", show);
    window.addEventListener("pinai:kbHide", hide);
    return () => {
      window.removeEventListener("pinai:kbShow", show);
      window.removeEventListener("pinai:kbHide", hide);
    };
  }, []);

  const flushHidden = (el: HTMLInputElement) => {
    const value = el.value;
    if (!value) return;
    void onUserInputText(value);
    el.value = "";
  };
  const handleHiddenInputInput = (e: ReactFormEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    flushHidden(e.currentTarget);
  };
  const handleCompositionStart = () => {
    composingRef.current = true;
  };
  const handleCompositionEnd = (e: ReactCompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    flushHidden(e.currentTarget);
  };
  const handleHiddenInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current) return;
    if (e.key === "Backspace" || e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      void onUserInputKey(e.key);
    }
  };
  const focusKeyboard = () => {
    hiddenInputRef.current?.focus();
  };
  const dismissKeyboard = () => {
    hiddenInputRef.current?.blur();
  };

  // Overlay is disabled — native iframe handles clicks / horizontal scroll
  // (wrapper.overflow-x) / Browserbase's own URL bar directly. Vertical
  // scroll and pinch-zoom can't ride that path because iOS WKWebView
  // doesn't surface cross-origin iframe touches to outer document
  // listeners (WebKit bug 149264). Instead we expose explicit floating
  // controls (↑ ↓ + −) that translate to backend commands — see below.
  const overlayActive = false;

  const ZOOM_STEP = 1.2;
  // Floor at fit-to-height. Going smaller leaves a black letterbox at the
  // panel's right + bottom (transform-origin is top-left), and "smaller
  // than fits exactly" has no real use case.
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const zoomInStep = () => {
    setUserZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP));
  };
  const zoomOutStep = () => {
    setUserZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP));
  };

  // Drag-pad scroll: one finger pixel maps to DRAG_PAD_GAIN remote-viewport
  // pixels, accumulated and flushed at most once per animation frame so a
  // long drag doesn't spam /input. Gain is tuned so a comfortable thumb
  // throw (~80 px on a phone) covers roughly one screen of remote content.
  const DRAG_PAD_GAIN = 5;
  const dragStartRef = useRef<{ lastY: number; pointerId: number } | null>(null);
  const accumDyRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const flushDragScroll = () => {
    rafIdRef.current = null;
    const dy = Math.round(accumDyRef.current);
    accumDyRef.current = 0;
    if (dy !== 0) void onUserInputScroll(0, dy);
  };
  const handleDragPadDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { lastY: e.clientY, pointerId: e.pointerId };
  };
  const handleDragPadMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStartRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const rawDy = e.clientY - drag.lastY;
    drag.lastY = e.clientY;
    accumDyRef.current += rawDy * DRAG_PAD_GAIN;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(flushDragScroll);
    }
  };
  const handleDragPadUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStartRef.current = null;
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      flushDragScroll();
    }
  };
  // Cancel any pending rAF on unmount so a flushed scroll doesn't fire
  // after the panel is gone (would hit a dead session).
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);
  const pressEnter = () => {
    void onUserInputKey("Enter");
  };

  const statusDot = (
    <span
      className={
        controlMode === "ai"
          ? "inline-block w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_6px_hsl(210_100%_60%)] animate-pulse"
          : "inline-block w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_hsl(38_100%_60%)]"
      }
    />
  );
  const statusLabel = takeoverReason
    ? "Needs your help"
    : controlMode === "ai"
      ? "AI is browsing"
      : "You have control";

  const cycleIcon =
    sheetStage === "full" || sheetStage === "medium" ? (
      <ChevronUp size={15} strokeWidth={2} />
    ) : (
      <ChevronDown size={15} strokeWidth={2} />
    );
  const cycleTitle = sheetStage === "mini" ? "Expand" : "Minimize";

  // Use the live view URL as-is — Browserbase's own chrome (URL bar +
  // back/forward/reload) is intentionally visible because it gives users
  // the desktop browser controls they expect.
  const iframeSrc = liveViewUrl;

  // Cursor pin in panel coords needs to track scrollLeft because the
  // wrapper is horizontally scrollable.
  const scrollLeft = wrapperRef.current?.scrollLeft ?? 0;

  return (
    <div
      className="flex flex-col h-full w-full overflow-hidden"
      style={{
        background:
          "linear-gradient(180deg, hsl(230 18% 13%) 0%, hsl(230 22% 9%) 100%)",
        borderBottomLeftRadius: 22,
        borderBottomRightRadius: 22,
        boxShadow:
          "0 18px 48px -18px hsla(230, 60%, 8%, 0.5), 0 1px 0 hsla(0, 0%, 100%, 0.06) inset",
      }}
    >
      {/* Two-layer container so the floating buttons can be `absolute`
          against a non-scrolling parent (this outer div) instead of
          drifting away with the scroll content inside the inner wrapper.
          The inner wrapper is the actual horizontal scroll viewport;
          buttons live as siblings of it, anchored to the outer's bottom-
          right and immune to wrapper.scrollLeft.
          IMPORTANT: outer must be `relative` even in mini, otherwise the
          inner wrapper's `absolute inset-0` walks up to the panel's
          motion.div (the next positioned ancestor) and stretches over
          the whole panel — iframe content leaks past the h-0 outer and
          the sizer's huge visualW thrashes layout, locking the drag handle. */}
      <div
        className={
          isMini
            ? "relative h-0 overflow-hidden"
            : "relative flex-1 overflow-hidden bg-black"
        }
      >
        <div
          ref={wrapperRef}
          className={
            isMini
              ? "absolute inset-0"
              : fitToWidth
                // Mobile/tablet: BB viewport already matches panel width,
                // iframe is 1:1 to panel — clip everything, no scrollbars.
                ? "absolute inset-0 overflow-hidden"
                : "absolute inset-0 overflow-x-auto overflow-y-hidden"
          }
          style={
            isMini
              ? undefined
              : { touchAction: overlayActive ? "none" : "auto" }
          }
        >
        {!sessionReady && !isMini && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-[1]">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-white/50" />
              <span className="text-[12.5px] text-white/50">Loading browser...</span>
            </div>
          </div>
        )}
        <div
          style={{
            width: visualW || "100%",
            height: visualH || "100%",
            position: "relative",
          }}
        >
          <iframe
            key={`iframe-${iframeReloadKey}`}
            src={iframeSrc}
            onLoad={() => setIframeLoaded(true)}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            allow="clipboard-read; clipboard-write; fullscreen"
            title={`Browser session ${sessionId}`}
            style={{
              width: viewport.width,
              // Tall enough for Browserbase's own chrome + the remote viewport.
              height: layoutH,
              border: 0,
              display: "block",
              position: "absolute",
              top: 0,
              left: 0,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              // Native pass-through experiment: let iOS deliver clicks /
              // scroll / pinch to the iframe directly. Reverts to "none"
              // and re-enables the overlay if the gateway iframe doesn't
              // accept events on the device.
              pointerEvents: "auto",
            }}
          />
        </div>
        </div>

        {/* Floating control buttons — sibling of the scrolling wrapper, so
            their `absolute` is relative to the outer (non-scrolling)
            container. They stay pinned to the panel's bottom-right
            regardless of how far the user has scrolled the wrapper
            horizontally to see off-screen content. Only shown in user
            takeover mode; in AI mode the user is just watching. */}
        {!isMini && controlMode === "user" && (
          <div
            onPointerDown={stopDrag}
            className="pointer-events-none absolute bottom-3 right-3 z-[3] flex flex-col gap-3"
          >
            <div className="pointer-events-auto flex flex-col rounded-lg overflow-hidden bg-black/60 backdrop-blur-sm border border-white/10">
              <button
                onClick={zoomInStep}
                className="p-2 hover:bg-white/15 active:bg-white/25 text-white/85"
                title="Zoom in"
              >
                <Plus size={16} strokeWidth={2.5} />
              </button>
              <button
                onClick={zoomOutStep}
                className="p-2 hover:bg-white/15 active:bg-white/25 text-white/85 border-t border-white/10"
                title="Zoom out"
              >
                <Minus size={16} strokeWidth={2.5} />
              </button>
            </div>
            <div
              onPointerDown={handleDragPadDown}
              onPointerMove={handleDragPadMove}
              onPointerUp={handleDragPadUp}
              onPointerCancel={handleDragPadUp}
              // touch-action: none keeps iOS from claiming the gesture for
              // its own page scroll/zoom while we're capturing pointer
              // moves to forward as remote scroll deltas.
              style={{ touchAction: "none" }}
              title="Drag to scroll"
              className="pointer-events-auto flex items-center justify-center w-9 h-24 rounded-lg bg-black/60 backdrop-blur-sm border border-white/10 active:bg-black/75 cursor-grab active:cursor-grabbing"
            >
              <GripHorizontal size={16} className="text-white/65" />
            </div>
          </div>
        )}
        <input
          ref={hiddenInputRef}
          type="text"
          defaultValue=""
          onInput={handleHiddenInputInput}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onKeyDown={handleHiddenInputKeyDown}
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: "fixed",
            left: -9999,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
      </div>

      {isMini && <div className="flex-1" aria-hidden />}

      {!isMini && takeoverReason && (
        <div
          onPointerDown={stopDrag}
          className="mx-3 mt-2 flex items-start gap-2 px-2.5 py-2 rounded-xl bg-amber-500/95 text-black"
        >
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-[12px] leading-snug">
            <div className="font-medium">AI needs your help</div>
            <div className="opacity-80">{takeoverReason}</div>
          </div>
          <button
            onClick={() => onControlChange("ai")}
            className="shrink-0 px-2.5 py-1 rounded-md bg-black text-white text-[11px] font-medium hover:bg-black/80"
          >
            Done
          </button>
        </div>
      )}

      {/* Bottom chrome — controls + drag handle. */}
      <div
        className="shrink-0 select-none"
        onPointerDown={onChromePointerDown}
        style={{
          touchAction: "none",
          paddingBottom: isMini ? 0 : "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {!isMini && (
          <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2">
            <div
              onPointerDown={stopDrag}
              className="flex items-center gap-1.5 min-w-0"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.08] text-[11.5px] text-white/85">
                {statusDot}
                <span className="truncate">{statusLabel}</span>
              </div>

              {controlMode === "ai" ? (
                <button
                  onClick={() => onControlChange("user")}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.08] hover:bg-white/15 active:bg-white/20 text-white/85 text-[11.5px] transition-colors"
                >
                  <Hand size={12} strokeWidth={2} />
                  <span>Take over</span>
                </button>
              ) : (
                <button
                  onClick={() => onControlChange("ai")}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-500/25 hover:bg-blue-500/40 active:bg-blue-500/50 text-blue-100 text-[11.5px] transition-colors"
                >
                  <Bot size={12} strokeWidth={2} />
                  <span>Return to AI</span>
                </button>
              )}
            </div>

            <div
              onPointerDown={stopDrag}
              className="flex items-center gap-0.5 shrink-0"
            >
              {confirmingClose ? (
                <>
                  <button
                    onClick={() => setConfirmingClose(false)}
                    className="px-2.5 py-1 rounded-md text-[11.5px] text-white/75 hover:bg-white/10 active:bg-white/15"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingClose(false);
                      onRequestClose();
                    }}
                    className="px-2.5 py-1 rounded-md text-[11.5px] font-medium bg-red-500/85 hover:bg-red-500 active:bg-red-600 text-white"
                  >
                    Close
                  </button>
                </>
              ) : (
                <>
                  {isNative && controlMode === "user" && (
                    <button
                      // preventDefault on mousedown so the hidden input
                      // doesn't lose focus before our click runs — without
                      // this the keyboard hides itself on tap, then our
                      // blur() is a no-op and kbVisible never flips back.
                      onMouseDown={kbVisible ? (e) => e.preventDefault() : undefined}
                      onClick={kbVisible ? dismissKeyboard : focusKeyboard}
                      className="p-1.5 rounded-md hover:bg-white/10 active:bg-white/15 text-white/65"
                      title={kbVisible ? "Dismiss keyboard" : "Type"}
                    >
                      {kbVisible ? (
                        <ChevronDown size={15} strokeWidth={2} />
                      ) : (
                        <Keyboard size={15} strokeWidth={2} />
                      )}
                    </button>
                  )}
                  {isNative && controlMode === "user" && (
                    <button
                      onClick={pressEnter}
                      className="p-1.5 rounded-md hover:bg-white/10 active:bg-white/15 text-white/65"
                      title="Press Enter"
                    >
                      <CornerDownLeft size={15} strokeWidth={2} />
                    </button>
                  )}
                  <button
                    onClick={onCycleStage}
                    className="p-1.5 rounded-md hover:bg-white/10 active:bg-white/15 text-white/65"
                    title={cycleTitle}
                  >
                    {cycleIcon}
                  </button>
                  <button
                    onClick={() => setConfirmingClose(true)}
                    className="p-1.5 rounded-md hover:bg-white/10 active:bg-white/15 text-white/65"
                    title="Close browser"
                  >
                    <X size={15} strokeWidth={2} />
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <div
          className={
            isMini
              ? "flex items-center justify-center min-h-[40px]"
              : "flex justify-center py-3.5"
          }
        >
          <div
            className={
              isMini
                ? "h-1.5 w-14 rounded-full bg-white/55"
                : "h-1.5 w-14 rounded-full bg-white/45"
            }
          />
        </div>
      </div>
    </div>
  );
}
