import { type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useMotionValue, animate, useDragControls } from "framer-motion";
import { cn } from "@/lib/utils";
import { LEFT_EDGE_BACK_THRESHOLD_PX } from "@/components/chat/main-chat-entry-gesture";

/** Fraction of viewport width (or velocity) the drag must reach for release
 *  to commit the back navigation. Tuned on-device. */
const COMMIT_DISTANCE_FRACTION = 0.32;
const COMMIT_VELOCITY_PX_S = 400;

interface SwipeBackLayerProps {
  /** Called after the layer has slid fully off-screen (commit) — typically
   *  unmounts this layer, revealing whatever is underneath. */
  onBack: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * iOS-style interactive edge-swipe-back.
 *
 * Two things the first version got wrong and this fixes:
 *  1. The edge hit-zone sits LAST in the DOM with the highest z-index, so a
 *     full-screen `absolute inset-0` child (MainChatView) can't swallow the
 *     edge pointerdown — that was why card/main chat wouldn't drag at all.
 *  2. Instead of unmounting the instant the threshold is crossed (which felt
 *     like an abrupt "cut"), we drive an explicit motion value: the content
 *     follows the finger, and on release it either slides the rest of the way
 *     out (then calls onBack) or springs back — a continuous, finger-tracked
 *     motion.
 */
export default function SwipeBackLayer({
  onBack,
  children,
  className,
}: SwipeBackLayerProps) {
  const controls = useDragControls();
  const x = useMotionValue(0);

  const startFromEdge = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.clientX <= LEFT_EDGE_BACK_THRESHOLD_PX) {
      controls.start(e);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <motion.div
        drag="x"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ left: 0 }}
        dragElastic={0}
        style={{ x }}
        className={cn("h-full w-full", className)}
        onDragEnd={(_event, info) => {
          const screenW =
            typeof window === "undefined" ? 9999 : window.innerWidth;
          const commit =
            info.offset.x > screenW * COMMIT_DISTANCE_FRACTION ||
            info.velocity.x > COMMIT_VELOCITY_PX_S;
          if (commit) {
            // Slide the rest of the way out, continuous with the drag, then pop.
            animate(x, screenW, {
              duration: 0.2,
              ease: [0.32, 0.72, 0, 1],
              onComplete: onBack,
            });
          } else {
            // Didn't cross the threshold — spring back to rest.
            animate(x, 0, { type: "spring", stiffness: 500, damping: 40 });
          }
        }}
      >
        {children}
      </motion.div>
      {/* Edge hit-zone: LAST in DOM + highest z so full-screen children can't
          swallow the pointerdown. Only the leftmost ~24px is interactive. */}
      <div
        onPointerDown={startFromEdge}
        className="absolute left-0 top-0 bottom-0 w-6 z-[100]"
        style={{ touchAction: "none" }}
        aria-hidden="true"
      />
    </div>
  );
}
