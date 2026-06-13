import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";

/**
 * Floating jump-to-latest affordance. Visible whenever the viewport isn't at
 * the transcript tail; tapping jumps to the bottom and engages follow mode
 * (useChatScroll.jumpToLatest). `attention` pulses a dot when something new
 * landed below the fold (a proactive turn, a pending approval).
 */
export default function JumpToLatest({
  visible,
  attention,
  onClick,
}: {
  visible: boolean;
  attention: boolean;
  onClick: () => void;
}) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.9 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center"
        >
          <button
            type="button"
            onClick={onClick}
            aria-label="Scroll to latest"
            className="pointer-events-auto relative flex h-9 w-9 items-center justify-center rounded-full border border-foreground/[0.08] text-foreground/65 shadow-[0_2px_10px_rgba(0,0,0,0.08)] transition-colors hover:text-foreground"
            style={{
              background: "rgba(255,255,255,0.7)",
              backdropFilter: "blur(20px) saturate(1.4)",
              WebkitBackdropFilter: "blur(20px) saturate(1.4)",
            }}
          >
            <ChevronDown size={17} strokeWidth={2} />
            {attention ? (
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-primary" />
            ) : null}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
