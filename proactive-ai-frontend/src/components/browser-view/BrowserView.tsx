import {
  useEffect,
  useRef,
  useState,
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
  RotateCw,
} from "lucide-react";

export type SheetStage = "mini" | "medium" | "full";

interface BrowserViewProps {
  liveViewUrl: string;
  sessionId: string;
  controlMode: "ai" | "user" | "idle";
  takeoverReason?: string | null;
  iframeReloadKey?: number;
  sheetStage: SheetStage;
  isNative: boolean;
  /** Remote page viewport in CSS px — needed to scale overlay-local
   *  tap/swipe coordinates into remote page coordinates when we forward
   *  gestures through /input. Defaults fine-tuned for mobile preset. */
  viewport: { width: number; height: number };
  onControlChange: (mode: "ai" | "user") => void;
  onUserInputText: (text: string) => Promise<void>;
  onUserInputKey: (key: string) => Promise<void>;
  /** Sent when the user taps (short press, no significant drag) inside
   *  the overlay. x/y are already scaled to remote viewport coordinates. */
  onUserInputClick: (x: number, y: number) => Promise<void>;
  /** Sent on pan end with the total drag delta already scaled to remote
   *  viewport coordinates. We only forward one scroll per gesture to
   *  keep the HTTP chatter bounded; inertia is up to Browserbase. */
  onUserInputScroll: (dx: number, dy: number) => Promise<void>;
  onCycleStage: () => void;
  onRequestClose: () => void;
  onReload: () => void;
  onChromePointerDown: (e: ReactPointerEvent) => void;
}

export default function BrowserView({
  liveViewUrl,
  sessionId,
  controlMode,
  takeoverReason,
  iframeReloadKey = 0,
  sheetStage,
  isNative,
  viewport,
  onControlChange,
  onUserInputText,
  onUserInputKey,
  onUserInputClick,
  onUserInputScroll,
  onCycleStage,
  onRequestClose,
  onReload,
  onChromePointerDown,
}: BrowserViewProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [mobileInput, setMobileInput] = useState("");
  const [sendingInput, setSendingInput] = useState(false);

  useEffect(() => {
    if (!confirmingClose) return;
    const t = setTimeout(() => setConfirmingClose(false), 4000);
    return () => clearTimeout(t);
  }, [confirmingClose]);

  useEffect(() => {
    if (!reloading) return;
    const t = setTimeout(() => setReloading(false), 4000);
    return () => clearTimeout(t);
  }, [reloading, iframeReloadKey]);

  const isMini = sheetStage === "mini";
  const stopDrag = (e: ReactPointerEvent) => e.stopPropagation();

  // Transparent touch overlay (native + user mode): tap → /input click,
  // pan → /input scroll. Browserbase's DevTools-based Live View doesn't
  // forward native mobile touches to the remote page reliably, so we
  // capture them here and forward scaled coordinates to Playwright.
  const overlayActive =
    isNative && !isMini && controlMode === "user";
  const TAP_THRESHOLD_PX = 8;
  type OverlayGesture = {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startTime: number;
    moved: boolean;
    rect: DOMRect;
  };
  const gestureRef = useRef<OverlayGesture | null>(null);

  const handleOverlayPointerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startTime: performance.now(),
      moved: false,
      rect,
    };
  };

  const handleOverlayPointerMove = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > TAP_THRESHOLD_PX) g.moved = true;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
  };

  const handleOverlayPointerUp = (e: ReactPointerEvent) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gestureRef.current = null;
    const { rect } = g;
    if (rect.width === 0 || rect.height === 0) return;
    const scaleX = viewport.width / rect.width;
    const scaleY = viewport.height / rect.height;
    if (!g.moved) {
      const x = (g.lastX - rect.left) * scaleX;
      const y = (g.lastY - rect.top) * scaleY;
      void onUserInputClick(x, y);
      return;
    }
    // Swipe up on the screen (lastY < startY → dy negative) should scroll
    // the remote page content DOWN (reveal content below), which in
    // wheel coordinates is positive dy. Hence negate the sign.
    const dx = -(g.lastX - g.startX) * scaleX;
    const dy = -(g.lastY - g.startY) * scaleY;
    if (Math.hypot(dx, dy) < 1) return;
    void onUserInputScroll(dx, dy);
  };

  const handleOverlayPointerCancel = (e: ReactPointerEvent) => {
    if (gestureRef.current?.pointerId === e.pointerId) {
      gestureRef.current = null;
    }
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

  const handleReload = () => {
    setReloading(true);
    onReload();
  };

  const sendMobileText = async () => {
    const text = mobileInput;
    if (!text || sendingInput) return;
    setSendingInput(true);
    try {
      await onUserInputText(text);
      setMobileInput("");
    } finally {
      setSendingInput(false);
    }
  };

  const sendMobileKey = async (key: string) => {
    if (sendingInput) return;
    setSendingInput(true);
    try {
      await onUserInputKey(key);
    } finally {
      setSendingInput(false);
    }
  };

  // Cycle chevron:
  //  full   → medium (collapse)  → up arrow
  //  medium → mini   (collapse)  → up arrow
  //  mini   → full   (expand)    → down arrow (but mini hides chrome buttons)
  const cycleIcon =
    sheetStage === "full" || sheetStage === "medium" ? (
      <ChevronUp size={15} strokeWidth={2} />
    ) : (
      <ChevronDown size={15} strokeWidth={2} />
    );
  const cycleTitle = sheetStage === "mini" ? "Expand" : "Minimize";

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
      {/* iframe container at panel top. Collapsed to h-0 in mini so the
          panel becomes just the drag bar (WebSocket stays live because the
          iframe is still in the DOM; only its height is 0).
          Note: in mini we also render a flex-1 spacer below this element —
          without it, DOM order would pull chrome up to panel-top (right
          after h-0 iframe), which after translateY pushes chrome off-screen
          and the drag handle becomes unreachable. The spacer keeps chrome
          pinned to panel-bottom regardless of iframe height. */}
      <div
        className={
          isMini
            ? "h-0 overflow-hidden"
            : "relative flex-1 overflow-hidden bg-black"
        }
        style={
          isMini
            ? undefined
            : { touchAction: overlayActive ? "none" : "auto" }
        }
      >
        {!iframeLoaded && !isMini && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-[1]">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-white/50" />
              <span className="text-[12.5px] text-white/50">Loading browser...</span>
            </div>
          </div>
        )}
        <iframe
          key={`iframe-${iframeReloadKey}`}
          src={liveViewUrl}
          onLoad={() => {
            setIframeLoaded(true);
            setReloading(false);
          }}
          className="w-full h-full border-0 block"
          style={{
            touchAction: "auto",
            // When our touch overlay is active (native + user mode),
            // iframe must be click-through so the overlay catches every
            // pointer; otherwise on desktop user mode the iframe's own
            // Browserbase DevTools UI receives clicks directly.
            pointerEvents:
              controlMode === "user" && !overlayActive ? "auto" : "none",
          }}
          allow="clipboard-read; clipboard-write; fullscreen"
          title={`Browser session ${sessionId}`}
        />
        {overlayActive && (
          <div
            className="absolute inset-0 z-[2]"
            style={{ touchAction: "none", pointerEvents: "auto" }}
            onPointerDown={handleOverlayPointerDown}
            onPointerMove={handleOverlayPointerMove}
            onPointerUp={handleOverlayPointerUp}
            onPointerCancel={handleOverlayPointerCancel}
          />
        )}
      </div>

      {/* Mini spacer — pushes chrome to panel bottom so translateY reveals
          the drag handle in the visible 40px strip. */}
      {isMini && <div className="flex-1" aria-hidden />}

      {/* Takeover banner — medium and full only. Peek/mini stays out of the
          way since the iframe isn't visible there anyway. */}
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

      {isNative && !isMini && controlMode === "user" && (
        <div
          onPointerDown={stopDrag}
          className="mx-3 mt-2 flex flex-col gap-2 rounded-xl border border-white/10 bg-black/35 p-2"
        >
          <div className="flex items-center gap-1.5">
            <input
              value={mobileInput}
              onChange={(e) => setMobileInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void sendMobileText();
              }}
              className="min-w-0 flex-1 rounded-lg bg-white/10 px-2.5 py-2 text-[16px] text-white outline-none placeholder:text-white/35"
              placeholder="Type into browser"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={() => void sendMobileText()}
              disabled={!mobileInput || sendingInput}
              className="shrink-0 rounded-lg bg-white/15 px-3 py-2 text-[12px] font-medium text-white disabled:opacity-35"
            >
              Send
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {["Enter", "Tab", "Backspace"].map((key) => (
              <button
                key={key}
                onClick={() => void sendMobileKey(key)}
                disabled={sendingInput}
                className="rounded-lg bg-white/[0.08] px-2.5 py-1.5 text-[11.5px] text-white/80 disabled:opacity-35"
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chrome at panel bottom — entire region is the drag source.
          Structure: [controls row (top)] [drag handle (bottom)] — so in mini
          (only bottom ~32px visible) the user sees the drag handle and
          nothing else. */}
      <div
        className="shrink-0 select-none"
        onPointerDown={onChromePointerDown}
        style={{ touchAction: "none" }}
      >
        {/* Controls row — hidden in mini (no room, and intentionally no
            controls there so the user commits to expanding before acting). */}
        {!isMini && (
          <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2">
            {/* Left: status pill + Take over / Return to AI */}
            <div
              onPointerDown={stopDrag}
              className="flex items-center gap-1.5 min-w-0"
            >
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.08] text-[11.5px] text-white/85">
                {statusDot}
                <span className="truncate">{statusLabel}</span>
              </div>

              {controlMode === "ai" ? (
                <div className="relative">
                  <button
                    onClick={() => onControlChange("user")}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.08] hover:bg-white/15 active:bg-white/20 text-white/85 text-[11.5px] transition-colors"
                  >
                    <Hand size={12} strokeWidth={2} />
                    <span>Take over</span>
                  </button>
                </div>
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

            {/* Right: Reload + cycle + close */}
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
                  <button
                    onClick={handleReload}
                    className="p-1.5 rounded-md hover:bg-white/10 active:bg-white/15 text-white/65"
                    title="Reload browser view"
                  >
                    <RotateCw
                      size={14}
                      strokeWidth={2}
                      className={reloading ? "animate-spin" : ""}
                    />
                  </button>
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

        {/* Drag handle — bottom of chrome, so in mini it's the only thing
            visible (panel bottom ≈ drag handle). In mini we stretch the
            wrapper to the full 40px panel-visible height so the whole strip
            is a tap target (iOS recommends ≥44, this gets close and works
            fine with a pointerdown-captured drag). */}
        <div
          className={
            isMini
              ? "flex items-center justify-center min-h-[40px]"
              : "flex justify-center py-2.5"
          }
        >
          <div
            className={
              isMini
                ? "h-1.5 w-14 rounded-full bg-white/55"
                : "h-1 w-9 rounded-full bg-white/30"
            }
          />
        </div>
      </div>
    </div>
  );
}
