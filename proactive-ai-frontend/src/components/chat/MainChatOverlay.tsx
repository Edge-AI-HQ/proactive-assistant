import { useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useDragControls,
  animate,
} from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import MainChat from "@/components/chat/MainChat";
import { LEFT_EDGE_BACK_THRESHOLD_PX } from "@/components/chat/main-chat-entry-gesture";

/** Drag distance (fraction of viewport width) or velocity past which releasing
 *  commits the dismiss. Tuned on-device. */
const COMMIT_DISTANCE_FRACTION = 0.35;
const COMMIT_VELOCITY_PX_S = 400;
/** Panel sink distance per unit of finger travel. >1 sinks a touch faster than
 *  the finger moves. */
const SINK_RATIO = 1.5;

interface MainChatOverlayProps {
  /** Opens the overlay. Toggled by the bottom-center ASK PIN AI button. */
  open: boolean;
  /** Closes the overlay (swipe-dismiss commit or the chat's own back button). */
  onBack: () => void;
}

/**
 * Main chat overlay. Opened by the bottom-center ASK PIN AI button.
 * Separate from card chat: a standalone main thread per user. The portal
 * escapes the Constellation tree (so z-index is unambiguous and the hamburger
 * menu doesn't interfere) but the inner panel forces the same `max-w-md` mobile
 * column the rest of the app uses.
 *
 * Dismiss is an iOS bottom-sheet gesture: a left-edge swipe sinks the WHOLE
 * panel DOWNWARD, finger-tracked (rightward drag offset → downward travel),
 * revealing the live Now tab beneath — like a comment sheet pushed down. Release
 * past the threshold finishes the dismiss; otherwise the panel springs back up.
 * Entry mirrors it (springs up from the bottom). Everything animates
 * transform/opacity only, so the WKWebView keeps it on the GPU compositor for a
 * native-feeling sheet. Card chat keeps its own horizontal SwipeBackLayer — this
 * sheet doesn't use it, the two dismissal idioms are intentionally different.
 */
export default function MainChatOverlay({ open, onBack }: MainChatOverlayProps) {
  const controls = useDragControls();
  // Panel vertical offset: 0 = fully open, screenH = fully dismissed (off the
  // bottom). Initialised off-screen so the first open springs up from below.
  const y = useMotionValue(typeof window === "undefined" ? 0 : window.innerHeight);

  // Entry: every time it opens, drop to the bottom then spring up.
  useEffect(() => {
    if (!open) return;
    const screenH = typeof window === "undefined" ? 0 : window.innerHeight;
    y.set(screenH);
    const entry = animate(y, 0, {
      type: "spring",
      stiffness: 320,
      damping: 32,
      mass: 0.9,
    });
    return () => entry.stop();
  }, [open, y]);

  // Finish sinking the panel off the bottom, then unmount.
  const dismiss = () => {
    const screenH = typeof window === "undefined" ? 9999 : window.innerHeight;
    animate(y, screenH, {
      duration: 0.5,
      ease: [0.32, 0.72, 0, 1],
      onComplete: onBack,
    });
  };

  // Only a pointerdown in the left-edge zone arms the drag, so it never steals
  // scrolls / taps inside the chat.
  const startFromEdge = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.clientX <= LEFT_EDGE_BACK_THRESHOLD_PX) controls.start(e);
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="main-chat-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          className="fixed inset-0 z-50 flex justify-center bg-foreground/[0.04]"
        >
          <motion.div
            drag="x"
            dragControls={controls}
            dragListener={false}
            // Lock horizontal travel; the left-edge swipe drives `y` (onDrag)
            // so the whole sheet sinks DOWN with the finger, not sideways.
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0}
            style={{ y }}
            onDrag={(_event, info) => {
              // Rightward drag → downward sink, finger-tracked (a touch faster
              // than the finger via SINK_RATIO). Clamp at 0 so dragging back
              // past the start can't lift the panel above the top.
              y.set(Math.max(0, info.offset.x * SINK_RATIO));
            }}
            onDragEnd={(_event, info) => {
              const screenW =
                typeof window === "undefined" ? 9999 : window.innerWidth;
              const commit =
                info.offset.x > screenW * COMMIT_DISTANCE_FRACTION ||
                info.velocity.x > COMMIT_VELOCITY_PX_S;
              if (commit) {
                dismiss();
              } else {
                // Not far enough — spring back up to fully open.
                animate(y, 0, { type: "spring", stiffness: 500, damping: 40 });
              }
            }}
            className="relative w-full max-w-md h-screen overflow-hidden bg-background will-change-transform"
          >
            {/* Aurora backdrop — same layers as the Constellation root, on top
                of the opaque bg-background, so the panel is NOT see-through and
                rides down as one solid sheet when swiped, revealing the Now tab
                beneath instead of a flat white panel. */}
            <img
              src={bgGradient}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-60"
              aria-hidden="true"
            />
            <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
            <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
            <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
            <div className="absolute inset-0 bg-white/35" aria-hidden="true" />
            <MainChat onBack={dismiss} />
            {/* Left-edge hit-zone: LAST in DOM + highest z so MainChat's
                full-screen children can't swallow the pointerdown. Only the
                leftmost ~24px is interactive. */}
            <div
              onPointerDown={startFromEdge}
              className="absolute left-0 top-0 bottom-0 w-6 z-[100]"
              style={{ touchAction: "none" }}
              aria-hidden="true"
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
