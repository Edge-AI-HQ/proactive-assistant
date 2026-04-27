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
import BrowserView, { type SheetStage } from "./BrowserView";
import { proxyPost } from "@/lib/api";
import { isNative } from "@/lib/platform";

interface BrowserSession {
  browserSessionId: string;
  liveViewUrl: string;
  viewport: { width: number; height: number };
  currentUrl: string;
  controlMode: "ai" | "user" | "idle";
  takeoverReason?: string | null;
}

interface BrowserPanelProps {
  session: BrowserSession | null;
  iframeReloadKey?: number;
  onIframeReload: () => void;
  onControlChange: (mode: "ai" | "user") => void;
  onUserInputText: (text: string) => Promise<void>;
  onUserInputKey: (key: string) => Promise<void>;
  onUserInputClick: (x: number, y: number) => Promise<void>;
  onUserInputScroll: (dx: number, dy: number) => Promise<void>;
  onUserNavigate: (url: string) => Promise<void>;
  onUserBack: () => Promise<void>;
  onUserForward: () => Promise<void>;
  onUserPageReload: () => Promise<void>;
  onClose: () => void;
  onStageChange?: (stage: SheetStage | "closed") => void;
  onLiveViewUrlRefreshed: (url: string) => void;
  /** When the composer in MainChatView gains focus (keyboard coming up),
   *  panel demotes from full → medium so the composer isn't covered.
   *  Medium / mini stay put — that's the user's explicit choice. */
  composerFocused: boolean;
}

const MINI_HEIGHT = 28;

/** Medium = the previous "full": ~55% of viewport, leaves room for composer. */
function mediumHeight(availableH: number): number {
  return Math.min(Math.round(availableH * 0.55), availableH - 140);
}

/** Full = the entire chat region (header-bottom down to the window bottom).
 *  Panel is `absolute top-0` inside MainChatView's `relative flex-1` wrapper,
 *  which sits below the header. Stretching the panel to availableH
 *  (== window.innerHeight) lets it extend past the composer all the way to
 *  the window bottom; the parent has no overflow:hidden so the overflow
 *  simply covers the composer area — which is what "full" means here. */
function fullHeight(availableH: number): number {
  return availableH;
}

const SPRING = { type: "spring" as const, damping: 32, stiffness: 340 };

export default function BrowserPanel({
  session,
  iframeReloadKey = 0,
  onIframeReload,
  onControlChange,
  onUserInputText,
  onUserInputKey,
  onUserInputClick,
  onUserInputScroll,
  onUserNavigate,
  onUserBack,
  onUserForward,
  onUserPageReload,
  onClose,
  onStageChange,
  onLiveViewUrlRefreshed,
  composerFocused,
}: BrowserPanelProps) {
  const [stage, setStage] = useState<SheetStage>("medium");
  // Measure the panel's actual parent (the `.relative.flex-1` chat-region
  // div in MainChatView). Using window.innerHeight overshoots by the header
  // height, which makes the panel taller than its absolute container — the
  // bottom chrome (drag handle + close button) gets pushed offscreen and
  // the user can't escape `full` stage anymore.
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
  // Panel height is fixed at fullH; translateY hides part of it.
  //   mini:   y = -(fullH - MINI_HEIGHT)  — only bottom 28px visible (drag handle)
  //   medium: y = -(fullH - mediumH)      — bottom ~55%vh visible
  //   full:   y = 0                       — entire panel visible (covers composer)
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

  // Reset to full when a different session arrives.
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
  // Mini/medium stay — that's the user's explicit choice.
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

  // Stage change (via cycle button, takeover promotion, composer focus):
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
        // Same stage — effect won't rerun. Snap y back manually.
        animate(y, yForStage(stage), SPRING);
      } else {
        setStage(nearest.stage);
      }
    },
    [y, miniY, mediumY, fullY, stage, yForStage],
  );

  // Cycle button: full → medium → mini → full (only reachable from medium/full
  // since chrome buttons are hidden in mini).
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

  const handleReload = useCallback(async () => {
    if (!session) return;
    // Only bump iframe key on success. Bumping on failure re-mounts the iframe
    // with the *same* (possibly expired) URL, and Browserbase then renders a
    // "Debugging connection was closed" page — visually indistinguishable from
    // the browser panel "disappearing."
    try {
      const res = await proxyPost(
        `/browser/sessions/${session.browserSessionId}/refresh-live-view-url`,
        {},
      );
      if (!res.ok) {
        console.warn(
          "[BrowserPanel] refresh-live-view-url failed",
          res.status,
        );
        return;
      }
      const data = (await res.json()) as { ok?: boolean; liveViewUrl?: string };
      if (!data.ok || !data.liveViewUrl) {
        console.warn("[BrowserPanel] refresh-live-view-url bad payload", data);
        return;
      }
      onLiveViewUrlRefreshed(data.liveViewUrl);
      onIframeReload();
    } catch (err) {
      console.warn("[BrowserPanel] refresh-live-view-url error", err);
    }
  }, [session, onIframeReload, onLiveViewUrlRefreshed]);

  useEffect(() => {
    if (!session || session.controlMode !== "user") return;
    const heartbeat = () => {
      void proxyPost(
        `/browser/sessions/${session.browserSessionId}/heartbeat`,
        {},
      );
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 25_000);
    return () => window.clearInterval(timer);
  }, [session?.browserSessionId, session?.controlMode]);

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
        currentUrl={session.currentUrl}
        controlMode={session.controlMode === "idle" ? "ai" : session.controlMode}
        takeoverReason={session.takeoverReason ?? null}
        iframeReloadKey={iframeReloadKey}
        sheetStage={stage}
        isNative={isNative}
        viewport={session.viewport}
        onControlChange={onControlChange}
        onUserInputText={onUserInputText}
        onUserInputKey={onUserInputKey}
        onUserInputClick={onUserInputClick}
        onUserInputScroll={onUserInputScroll}
        onUserNavigate={onUserNavigate}
        onUserBack={onUserBack}
        onUserForward={onUserForward}
        onUserPageReload={onUserPageReload}
        onCycleStage={cycleStage}
        onRequestClose={onClose}
        onReload={handleReload}
        onChromePointerDown={startDrag}
      />
    </motion.div>
  );
}
