import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  motion,
  animate,
  useDragControls,
  useMotionValue,
  type PanInfo,
} from "framer-motion";
import BrowserView, { type SheetStage } from "@/components/browser/BrowserView";
import { isNative } from "@/lib/platform";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  deviceKind: "mobile" | "tablet" | "desktop";
  currentUrl: string;
  controlMode: "ai" | "user" | "idle";
  takeoverReason?: string | null;
}

interface BrowserPanelProps {
  session: BrowserSession | null;
  /** Foreground-bump key for the iframe — passed through to force a remount
   *  when iOS resumes the app and the Browserbase WebSocket is dead. */
  iframeReloadKey?: number;
  onControlChange: (mode: "ai" | "user") => void;
  onUserInputText: (text: string) => Promise<void>;
  onUserInputKey: (key: string) => Promise<void>;
  onUserInputClick: (x: number, y: number) => Promise<void>;
  onUserInputScroll: (dx: number, dy: number) => Promise<void>;
  onClose: () => void;
  onStageChange?: (stage: SheetStage | "closed") => void;
  /** When the composer in MainChatView gains focus (keyboard coming up),
   *  panel demotes from full → medium so the composer isn't covered.
   *  Medium / mini stay put — that's the user's explicit choice. */
  composerFocused: boolean;
}

const MINI_HEIGHT = 28;

/** Medium = previous "full": ~55% of viewport, leaves room for composer. */
function mediumHeight(availableH: number): number {
  return Math.min(Math.round(availableH * 0.55), availableH - 140);
}

/** Full = entire chat region (header-bottom down to the window bottom).
 *  Panel is `absolute top-0` inside MainChatView's `relative flex-1` wrapper
 *  which sits below the header. Stretching to availableH (parent.clientHeight,
 *  measured by ResizeObserver) lets the panel cover the composer area. */
function fullHeight(availableH: number): number {
  return availableH;
}

const SPRING = { type: "spring" as const, damping: 32, stiffness: 340 };

export default function BrowserPanel({
  session,
  iframeReloadKey = 0,
  onControlChange,
  onUserInputText,
  onUserInputKey,
  onUserInputClick,
  onUserInputScroll,
  onClose,
  onStageChange,
  composerFocused,
}: BrowserPanelProps) {
  const [stage, setStage] = useState<SheetStage>("medium");
  const panelRef = useRef<HTMLDivElement>(null);
  // Best guess before first measure — close enough that the initial spring
  // doesn't visibly snap when the ResizeObserver swaps in the real value.
  const [availableH, setAvailableH] = useState(() =>
    typeof window === "undefined"
      ? 700
      : Math.max(0, window.innerHeight - 80),
  );
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (!rendered) return;
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailableH(parent.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [rendered]);

  const fullH = useMemo(() => fullHeight(availableH), [availableH]);
  const mediumH = useMemo(() => mediumHeight(availableH), [availableH]);
  const miniY = -(fullH - MINI_HEIGHT);
  const mediumY = -(fullH - mediumH);
  const fullY = 0;

  const yForStage = useCallback(
    (s: SheetStage) => (s === "mini" ? miniY : s === "medium" ? mediumY : fullY),
    [miniY, mediumY, fullY],
  );

  const y = useMotionValue(-fullH);

  // Mount / unmount. AnimatePresence + motion value style binding don't mix
  // cleanly, so we own the visibility flag ourselves.
  useEffect(() => {
    if (session && !rendered) {
      setRendered(true);
      setStage("medium");
      y.set(-fullH);
      animate(y, mediumY, SPRING);
    } else if (!session && rendered) {
      const controls = animate(y, -fullH, {
        ...SPRING,
        onComplete: () => setRendered(false),
      });
      return () => controls.stop();
    }
    return undefined;
  }, [session, rendered, fullH, mediumY, y]);

  // Reset to medium when a different session arrives.
  const lastSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session) {
      lastSessionIdRef.current = null;
      return;
    }
    if (lastSessionIdRef.current !== session.browserSessionId) {
      lastSessionIdRef.current = session.browserSessionId;
      if (rendered) setStage("medium");
    }
  }, [session, rendered]);

  // Takeover promotes to at least medium so the amber banner is visible.
  useEffect(() => {
    if (session?.takeoverReason && stage === "mini") {
      setStage("medium");
    }
  }, [session?.takeoverReason, stage]);

  // Composer focus → auto-demote from full to medium only.
  useEffect(() => {
    if (composerFocused && stage === "full") {
      setStage("medium");
    }
  }, [composerFocused, stage]);

  // Viewport height change (rotation, keyboard, split-view): snap y to the
  // current stage's target immediately — no spring, avoids mid-rotation jank.
  useEffect(() => {
    if (!rendered) return;
    y.set(yForStage(stage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullH]);

  // Stage change (cycle button, takeover promotion, composer focus):
  // spring-animate y.
  useEffect(() => {
    if (!rendered) return;
    animate(y, yForStage(stage), SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, rendered]);

  useEffect(() => {
    onStageChange?.(session ? stage : "closed");
  }, [stage, session, onStageChange]);

  const dragControls = useDragControls();

  const onDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const currentY = y.get();
      const projectedY = currentY + info.velocity.y * 0.15;
      const candidates: Array<{ stage: SheetStage; y: number }> = [
        { stage: "mini", y: miniY },
        { stage: "medium", y: mediumY },
        { stage: "full", y: fullY },
      ];
      const nearest = candidates.reduce((best, c) =>
        Math.abs(c.y - projectedY) < Math.abs(best.y - projectedY) ? c : best,
      );
      if (nearest.stage === stage) {
        animate(y, yForStage(stage), SPRING);
      } else {
        setStage(nearest.stage);
      }
    },
    [y, miniY, mediumY, fullY, stage, yForStage],
  );

  const cycleStage = useCallback(() => {
    setStage((prev) =>
      prev === "full" ? "medium" : prev === "medium" ? "mini" : "full",
    );
  }, []);

  const startDrag = useCallback(
    (e: ReactPointerEvent) => {
      dragControls.start(e);
    },
    [dragControls],
  );

  // Heartbeat / lifecycle ownership lives in useBrowserSession — this
  // component is purely presentational over the session prop.

  if (!rendered || !session) return null;

  return (
    <motion.div
      ref={panelRef}
      className="absolute left-0 right-0 top-0 z-30"
      style={{
        height: fullH,
        y,
        touchAction: "auto",
      }}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: miniY, bottom: fullY }}
      dragElastic={0.06}
      onDragEnd={onDragEnd}
    >
      <BrowserView
        liveViewUrl={session.liveViewUrl}
        sessionId={session.browserSessionId}
        controlMode={session.controlMode === "idle" ? "ai" : session.controlMode}
        takeoverReason={session.takeoverReason ?? null}
        iframeReloadKey={iframeReloadKey}
        sheetStage={stage}
        isNative={isNative}
        viewport={session.viewport}
        deviceKind={session.deviceKind}
        onControlChange={onControlChange}
        onUserInputText={onUserInputText}
        onUserInputKey={onUserInputKey}
        onUserInputClick={onUserInputClick}
        onUserInputScroll={onUserInputScroll}
        onCycleStage={cycleStage}
        onRequestClose={onClose}
        onChromePointerDown={startDrag}
      />
    </motion.div>
  );
}
