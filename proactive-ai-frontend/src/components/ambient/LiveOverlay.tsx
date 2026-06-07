import { createPortal } from "react-dom";
import { AnimatePresence } from "framer-motion";
import { LiveFullscreen } from "@/components/ambient/AmbientView";
import type { LiveSession } from "@/services/ambient/live-session";

interface LiveOverlayProps {
  /** When set, the fullscreen overlay is shown. Holds the session that was
   *  opened from AmbientView (the "open fullscreen" handoff). */
  liveOverlay: LiveSession | null;
  /** Preferred live session from useAmbientLiveSession — when present it
   *  supersedes liveOverlay as the rendered session, so the overlay tracks
   *  the live stream rather than the snapshot captured at open time. */
  liveSession: LiveSession | null;
  onClose: () => void;
}

/**
 * Live session fullscreen overlay — rendered at root via portal, fully
 * independent of activeView. Wrapped in AnimatePresence so exit animation
 * runs cleanly without affecting the underlying view.
 */
export default function LiveOverlay({
  liveOverlay,
  liveSession,
  onClose,
}: LiveOverlayProps) {
  return createPortal(
    <AnimatePresence>
      {liveOverlay && (
        <LiveFullscreen
          key="live-fullscreen"
          session={liveSession ?? liveOverlay}
          onClose={onClose}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
