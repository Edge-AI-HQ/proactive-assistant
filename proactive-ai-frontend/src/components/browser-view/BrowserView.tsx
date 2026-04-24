import {
  useEffect,
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
  Info,
} from "lucide-react";

export type SheetStage = "mini" | "medium" | "full";

interface BrowserViewProps {
  liveViewUrl: string;
  sessionId: string;
  controlMode: "ai" | "user" | "idle";
  takeoverReason?: string | null;
  iframeReloadKey?: number;
  sheetStage: SheetStage;
  canTakeControl: boolean;
  onControlChange: (mode: "ai" | "user") => void;
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
  canTakeControl,
  onControlChange,
  onCycleStage,
  onRequestClose,
  onReload,
  onChromePointerDown,
}: BrowserViewProps) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [showTakeControlTip, setShowTakeControlTip] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!confirmingClose) return;
    const t = setTimeout(() => setConfirmingClose(false), 4000);
    return () => clearTimeout(t);
  }, [confirmingClose]);

  useEffect(() => {
    if (!showTakeControlTip) return;
    const t = setTimeout(() => setShowTakeControlTip(false), 3500);
    return () => clearTimeout(t);
  }, [showTakeControlTip]);

  useEffect(() => {
    if (!reloading) return;
    const t = setTimeout(() => setReloading(false), 4000);
    return () => clearTimeout(t);
  }, [reloading, iframeReloadKey]);

  const isMini = sheetStage === "mini";
  const stopDrag = (e: ReactPointerEvent) => e.stopPropagation();

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
        style={isMini ? undefined : { touchAction: "auto" }}
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
          style={{ touchAction: "auto", pointerEvents: "auto" }}
          allow="clipboard-read; clipboard-write; fullscreen"
          title={`Browser session ${sessionId}`}
        />
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
                    onClick={() =>
                      canTakeControl
                        ? onControlChange("user")
                        : setShowTakeControlTip(true)
                    }
                    aria-disabled={!canTakeControl}
                    className={
                      canTakeControl
                        ? "flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.08] hover:bg-white/15 active:bg-white/20 text-white/85 text-[11.5px] transition-colors"
                        : "flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/[0.04] text-white/40 text-[11.5px] cursor-not-allowed"
                    }
                  >
                    <Hand size={12} strokeWidth={2} />
                    <span>Take over</span>
                    {!canTakeControl && (
                      <Info size={11} strokeWidth={2} className="ml-0.5 text-white/50" />
                    )}
                  </button>
                  {showTakeControlTip && (
                    <div
                      className="absolute left-0 bottom-full mb-1.5 w-[220px] px-2.5 py-2 rounded-lg bg-black/95 text-white/90 text-[11px] leading-snug shadow-lg z-10 pointer-events-none"
                      style={{ touchAction: "none" }}
                    >
                      Manual control isn't supported on mobile yet — use desktop to take over.
                    </div>
                  )}
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
