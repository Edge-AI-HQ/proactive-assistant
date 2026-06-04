import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import bgGradient from "@/assets/bg-gradient.jpg";
import MainChat from "@/components/MainChat";
import SwipeBackLayer from "./SwipeBackLayer";

interface MainChatOverlayProps {
  /** Opens the overlay. Toggled by the bottom-center ASK PIN AI button. */
  open: boolean;
  /** Closes the overlay (swipe-back commit or the chat's own back button). */
  onBack: () => void;
}

/**
 * Main chat overlay. Opened by the bottom-center ASK PIN AI button.
 * Separate from card chat: a standalone main thread per user. The portal
 * escapes the Constellation tree (so z-index is unambiguous and the
 * hamburger menu doesn't interfere) but the inner container forces the same
 * `max-w-md` mobile column the rest of the app uses — without this, desktop
 * viewers see the chat sprawled full-width, breaking the minimalist design.
 */
export default function MainChatOverlay({ open, onBack }: MainChatOverlayProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        // iOS-style sheet entry: two-layer animation.
        //   - Outer backdrop fades in/out (opacity tween, easeOut, 280ms).
        //   - Inner content panel slides up from the bottom (spring).
        // Both layers animate transform/opacity only — no layout
        // properties — so the WKWebView keeps it on the GPU compositor
        // thread, matching the buttery feel of native iOS sheets.
        <motion.div
          key="main-chat-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          className="fixed inset-0 z-50 flex justify-center bg-foreground/[0.04]"
        >
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.9 }}
            className="relative w-full max-w-md h-screen overflow-hidden bg-background will-change-transform"
          >
            {/* Aurora backdrop — same layers as the Constellation root, on
                top of the opaque bg-background. So the panel is NOT
                see-through (the live Now tab can't bleed through the
                semi-transparent MainChatView), and swiping the chat back
                reveals this home aurora instead of a flat white panel.
                Sits beneath the swipe layer so it stays put as chat slides. */}
            <img src={bgGradient} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60" aria-hidden="true" />
            <div className="absolute inset-0 aurora-layer aurora-layer-1" aria-hidden="true" />
            <div className="absolute inset-0 aurora-layer aurora-layer-2" aria-hidden="true" />
            <div className="absolute inset-0 aurora-layer aurora-layer-3" aria-hidden="true" />
            <div className="absolute inset-0 bg-white/35" aria-hidden="true" />
            <SwipeBackLayer onBack={onBack} className="h-full">
              <MainChat onBack={onBack} />
            </SwipeBackLayer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
