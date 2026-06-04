import { type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useDragControls } from "framer-motion";
import { LEFT_EDGE_BACK_THRESHOLD_PX } from "./mainChatEntryGesture";

/** Fraction of viewport width the layer must travel (or velocity it must
 *  reach) for release to commit the back navigation. Tuned on-device. */
const COMMIT_DISTANCE_FRACTION = 0.35;
const COMMIT_VELOCITY_PX_S = 500;

interface SwipeBackLayerProps {
  /** Called when a left-edge drag is released past the commit threshold. */
  onBack: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * iOS-style interactive edge-swipe-back. The drag only starts from the
 * narrow left-edge hit-zone, so mid-screen horizontal scrolls / sphere
 * drags are never hijacked. dragSnapToOrigin springs the layer back when
 * the release doesn't commit; when it does, we call onBack() and the
 * parent unmounts us inside its AnimatePresence, playing the existing exit
 * transition.
 *
 * Note: the hit-zone is absolutely positioned, so the layer this wraps must
 * sit inside a positioned (relative/absolute) full-screen container.
 */
export default function SwipeBackLayer({
  onBack,
  children,
  className,
}: SwipeBackLayerProps) {
  const controls = useDragControls();

  const startFromEdge = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.clientX <= LEFT_EDGE_BACK_THRESHOLD_PX) {
      controls.start(e);
    }
  };

  return (
    <>
      {/* Left-edge hit-zone: transparent, only catches edge pointerdowns. */}
      <div
        onPointerDown={startFromEdge}
        className="absolute left-0 top-0 bottom-0 z-50 w-5"
        style={{ touchAction: "none" }}
        aria-hidden="true"
      />
      <motion.div
        drag="x"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ left: 0 }}
        dragElastic={0.12}
        dragSnapToOrigin
        onDragEnd={(_event, info) => {
          const screenW =
            typeof window === "undefined" ? Infinity : window.innerWidth;
          if (
            info.offset.x > screenW * COMMIT_DISTANCE_FRACTION ||
            info.velocity.x > COMMIT_VELOCITY_PX_S
          ) {
            onBack();
          }
        }}
        className={className}
        style={{ touchAction: "pan-y" }}
      >
        {children}
      </motion.div>
    </>
  );
}
