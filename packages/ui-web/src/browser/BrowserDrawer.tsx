import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "framer-motion";

interface BrowserDrawerProps {
  open: boolean;
  /** Drag-down dismiss / handle pull → collapse back to the header. */
  onClose: () => void;
  children: ReactNode;
}

const SPRING = { type: "spring" as const, damping: 34, stiffness: 350 };
const DISMISS_OFFSET_PX = 120;
const DISMISS_VELOCITY = 600;

/**
 * Bottom-sheet wrapper for the narrow (mobile / phone-width web) layout.
 * Slides up from the bottom and fills the chat region — full-screen, no
 * half-height stop (a half-height iframe is unusable on a phone). Collapse
 * via the in-view control bar or by dragging this handle down.
 *
 * Only the grab handle starts the drag (dragListener=false +
 * dragControls), so dragging never fights the live view inside.
 */
export default function BrowserDrawer({ open, onClose, children }: BrowserDrawerProps) {
  const dragControls = useDragControls();
  const startDrag = (e: ReactPointerEvent) => dragControls.start(e);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-40 flex flex-col bg-[hsl(230_22%_9%)]"
          style={{
            // Full-screen over the conversation (incl. its header) → clear the
            // notch / home indicator ourselves.
            paddingTop: "env(safe-area-inset-top, 0px)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={SPRING}
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.5 }}
          onDragEnd={(_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
            if (info.offset.y > DISMISS_OFFSET_PX || info.velocity.y > DISMISS_VELOCITY) {
              onClose();
            }
          }}
        >
          <div
            onPointerDown={startDrag}
            className="flex shrink-0 cursor-grab justify-center py-2 active:cursor-grabbing"
            style={{ touchAction: "none" }}
          >
            <div className="h-1.5 w-12 rounded-full bg-white/40" />
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
