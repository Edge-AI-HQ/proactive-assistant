import { useCallback, useRef, type PointerEvent, type TouchEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Zap, ListChecks, Settings, Radio, Plug, Target, Sparkles,
} from "lucide-react";
import { isMainMenuSwipeRight, type TouchPoint } from "./mainChatEntryGesture";
import type { MenuId } from "./useAppNavigation";
import type { ChatCard } from "./ChatDetailView";

/* ── Hamburger side menu items ── */
const MENU_ITEMS = [
  { id: "now", label: "NOW", icon: Zap },
  { id: "ambient", label: "AMBIENT", icon: Radio },
  { id: "chat", label: "TASKS", icon: ListChecks },
  { id: "connect", label: "CONNECT", icon: Plug },
  { id: "profile", label: "PROFILE", icon: Target },
  { id: "account", label: "SETTING", icon: Settings },
  { id: "proactive", label: "PROACTIVE", icon: Sparkles },
] as const;

interface SideMenuProps {
  open: boolean;
  /** The currently active top-level view, used to highlight the matching
   *  menu row. */
  activeView: MenuId;
  /** When a card chat is open the active-view highlight is suppressed
   *  (the menu sits above an overlay, not a top-level tab). */
  activeChat: ChatCard | null;
  onClose: () => void;
  onNavigate: (id: MenuId) => void;
}

/**
 * Hamburger side menu overlay. Slides in from the right; a rightward swipe
 * on either the scrim or the panel closes it (the close-swipe gesture is
 * self-contained here — it only needs onClose). The open gesture (left swipe
 * from the right edge) stays in ConstellationLayout because it competes with
 * the 3D sphere's pointer capture on the main surface.
 */
export default function SideMenu({
  open,
  activeView,
  activeChat,
  onClose,
  onNavigate,
}: SideMenuProps) {
  const menuCloseSwipeStartRef = useRef<TouchPoint | null>(null);
  const closeMenuFromSwipe = useCallback((
    end: TouchPoint,
    event: { preventDefault: () => void },
  ) => {
    const shouldClose = isMainMenuSwipeRight(menuCloseSwipeStartRef.current, end);
    if (!shouldClose) return;
    menuCloseSwipeStartRef.current = null;
    event.preventDefault();
    onClose();
  }, [onClose]);
  const handleMenuPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    menuCloseSwipeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, []);
  const handleMenuPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    closeMenuFromSwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
  }, [closeMenuFromSwipe]);
  const handleMenuPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    closeMenuFromSwipe({
      x: event.clientX,
      y: event.clientY,
    }, event);
    menuCloseSwipeStartRef.current = null;
  }, [closeMenuFromSwipe]);
  const handleMenuTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    menuCloseSwipeStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
    };
  }, []);
  const handleMenuTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    closeMenuFromSwipe({
      x: touch.clientX,
      y: touch.clientY,
    }, event);
  }, [closeMenuFromSwipe]);
  const handleMenuTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) {
      menuCloseSwipeStartRef.current = null;
      return;
    }
    closeMenuFromSwipe({
      x: touch.clientX,
      y: touch.clientY,
    }, event);
    menuCloseSwipeStartRef.current = null;
  }, [closeMenuFromSwipe]);
  const resetMenuCloseSwipe = useCallback(() => {
    menuCloseSwipeStartRef.current = null;
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-foreground/10 backdrop-blur-sm"
            onClick={onClose}
            onPointerDown={handleMenuPointerDown}
            onPointerMove={handleMenuPointerMove}
            onPointerUp={handleMenuPointerUp}
            onPointerCancel={resetMenuCloseSwipe}
            onTouchStart={handleMenuTouchStart}
            onTouchMove={handleMenuTouchMove}
            onTouchEnd={handleMenuTouchEnd}
            onTouchCancel={resetMenuCloseSwipe}
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 z-50 w-56"
            onPointerDown={handleMenuPointerDown}
            onPointerMove={handleMenuPointerMove}
            onPointerUp={handleMenuPointerUp}
            onPointerCancel={resetMenuCloseSwipe}
            onTouchStart={handleMenuTouchStart}
            onTouchMove={handleMenuTouchMove}
            onTouchEnd={handleMenuTouchEnd}
            onTouchCancel={resetMenuCloseSwipe}
            style={{
              background: "linear-gradient(180deg, hsl(0 0% 100% / 0.85) 0%, hsl(0 0% 100% / 0.95) 100%)",
              backdropFilter: "blur(48px) saturate(1.5)",
              WebkitBackdropFilter: "blur(48px) saturate(1.5)",
              borderLeft: "1px solid hsl(0 0% 100% / 0.5)",
            }}
          >
            <div className="pt-14 px-5">
              <button onClick={onClose} className="mb-8 p-1.5 rounded-full hover:bg-foreground/8">
                <X size={20} strokeWidth={1.5} className="text-foreground/60" />
              </button>
              <div className="flex flex-col gap-1">
                {MENU_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeView === item.id && !activeChat;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigate(item.id)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                        isActive ? "bg-foreground/8 text-foreground" : "text-foreground/50 hover:bg-foreground/4"
                      }`}
                    >
                      <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
                      <span className={`text-sm tracking-wider ${isActive ? "font-semibold" : "font-medium"}`}>
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
