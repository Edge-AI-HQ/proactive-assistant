import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { animate } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import CardDrawerContent from "@/components/card/CardDrawerContent";
import type { Intent } from "@/components/now/card-model";

interface CardDrawerProps {
  open: boolean;
  /** The tapped card whose detail is shown; null collapses the body (the
   *  Drawer shell still animates closed via `open`). */
  card: Intent | null;
  onOpenChange: (open: boolean) => void;
  /** Whether the card is in a completed state — drives CardDrawerContent's
   *  read-only "completed" layout. Computed by the parent from the real
   *  card outcome + optimistic doneIds. */
  completed: boolean;
  pending: boolean;
  onExecute: (card: Intent) => void;
  onClose: () => void;
  onDismiss: (card: Intent) => void;
  /** Done = acknowledge + retire (every card type); Chat = reminder cards'
   *  plain thread open. */
  onComplete: (card: Intent) => void;
  onChat: (card: Intent) => void;
}

/** Horizontal travel (px) after which the pointer locks into the swipe and
 *  stops being a candidate for taps / vertical scrolling. */
const SWIPE_LOCK_PX = 14;
/** Release commits when travel passes this fraction of the viewport width… */
const COMMIT_DISTANCE_FRACTION = 0.28;
/** …or when the flick is faster than this (px/s). */
const COMMIT_VELOCITY_PX_S = 500;
/** Sheet sink distance per unit of horizontal finger travel — same idiom
 *  (and ratio) as ChatSheetOverlay: sideways swipe, downward dismissal. */
const SINK_RATIO = 1.5;

/**
 * Card detail bottom-sheet. Thin shell around CardDrawerContent: owns the
 * vaul Drawer chrome (glass background, sr-only header) and forwards the
 * tapped card plus its action callbacks. All card lifecycle logic
 * (execute / dismiss / modify / completed lookup) stays in the parent so
 * behavior is unchanged.
 *
 * Horizontal swipe layer (this file's only logic): swipe RIGHT to close.
 * The rightward travel SINKS the whole sheet downward, finger-tracked — the
 * same dismiss idiom as the chat sheets (ChatSheetOverlay), not a sideways
 * slide. Leftward travel does nothing. Vertical gestures are untouched:
 * vaul's own drag-down-to-close and the body's scrolling win any
 * vertical-first pointer (touchAction "pan-y" + a direction lock).
 */
export default function CardDrawer({
  open,
  card,
  onOpenChange,
  completed,
  pending,
  onExecute,
  onClose,
  onDismiss,
  onComplete,
  onChat,
}: CardDrawerProps) {
  const { t } = useTranslation("card");
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    vx: number;
    locked: boolean;
    /** dx at the moment the gesture locked. The sink offset is measured from
     *  HERE, not from startX — otherwise the sheet starts ~21px deep
     *  (SWIPE_LOCK_PX × SINK_RATIO) the instant the lock engages, which read
     *  as a judder at the start of every swipe. */
    lockDx: number;
    /** Vertical direction won — scroll / vaul owns this pointer; stop looking. */
    dead: boolean;
  } | null>(null);

  /** The vaul DrawerContent DOM node — the WHOLE glass sheet. The sink
   *  transform goes here (not on the inner content wrapper) so the sheet
   *  rides down as one piece, matching the chat sheets' dismiss idiom. */
  const contentRef = useRef<HTMLDivElement>(null);
  /** In-flight settle animation — stopped when a new gesture grabs the panel
   *  so the two never write transform simultaneously. */
  const settleAnimRef = useRef<{ stop: () => void } | null>(null);
  /** Set when a locked swipe just ended: the browser still dispatches a
   *  click to whatever sits under the finger (the capture is released by
   *  then), which would double-fire a button under the release point. */
  const suppressClickRef = useRef(false);

  /** Animate the sheet's downward offset to `toY`, then run `after`. */
  const settle = useCallback((toY: number, after?: () => void) => {
    const el = contentRef.current;
    if (!el) {
      after?.();
      return;
    }
    const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
    const from = m ? Number(m[1]) : 0;
    settleAnimRef.current = animate(from, toY, {
      duration: 0.22,
      ease: [0.32, 0.72, 0, 1],
      onUpdate: (v) => {
        // vaul re-arms `transition: transform .5s` from its own pointerup
        // handler — which runs AFTER ours started this animation. A CSS
        // transition layered over per-frame JS writes renders as rubber-band
        // lag, so keep it suppressed for the whole animation.
        if (el.style.transition !== "none") el.style.transition = "none";
        el.style.transform = `translateY(${v}px)`;
      },
      onComplete: () => {
        settleAnimRef.current = null;
        // Hand transition / layer control back to vaul.
        el.style.transition = "";
        el.style.willChange = "";
        after?.();
      },
    });
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    settleAnimRef.current?.stop();
    settleAnimRef.current = null;
    // A suppress flag with no click to consume it (release over empty space)
    // must not eat the NEXT tap.
    suppressClickRef.current = false;
    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
      locked: false,
      lockDx: 0,
      dead: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gestureRef.current;
      if (!g || g.dead) return;
      // Single gesture arbiter: while the direction is UNDECIDED and while a
      // horizontal swipe is locked, moves must NOT bubble up to vaul's
      // DrawerContent (capture only redirects the target; it doesn't stop
      // propagation). Letting vaul see the pre-lock moves was the residual
      // judder: any vertical finger component made vaul nudge the sheet down
      // a few px, which our first translateY write then snapped back. Once a
      // pointer is judged VERTICAL (dead) we stop intercepting — vaul
      // computes its drag from absolute coordinates, so the few swallowed
      // moves don't affect it. pointerup always bubbles so vaul resets.
      e.stopPropagation();
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.locked) {
        if (Math.abs(dy) > SWIPE_LOCK_PX && Math.abs(dy) > Math.abs(dx)) {
          g.dead = true;
          return;
        }
        if (Math.abs(dx) <= SWIPE_LOCK_PX || Math.abs(dx) <= Math.abs(dy)) return;
        g.locked = true;
        g.lockDx = dx;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        const lockedEl = contentRef.current;
        if (lockedEl) {
          // Kill any CSS transition for the duration of the gesture: vaul
          // re-arms `transition: transform .5s` on pointerup, and a CSS
          // transition layered over per-frame JS transform writes renders as
          // rubber-band lag. Promote the sheet to its own GPU layer too.
          lockedEl.style.transition = "none";
          lockedEl.style.willChange = "transform";
        }
      }
      const now = performance.now();
      const dt = now - g.lastT;
      // Exponentially-smoothed velocity for the flick check on release.
      if (dt > 0) g.vx = ((e.clientX - g.lastX) / dt) * 1000 * 0.4 + g.vx * 0.6;
      g.lastX = e.clientX;
      g.lastT = now;
      const el = contentRef.current;
      // RIGHTWARD finger travel maps to DOWNWARD sheet travel (the chat
      // sheets' dismiss idiom — see ChatSheetOverlay's SINK_RATIO), measured
      // from the lock point so the sheet starts at 0 and tracks smoothly.
      // Leftward travel has no action; clamp at 0 so it can't lift the sheet.
      const sink = Math.max(0, dx - g.lockDx) * SINK_RATIO;
      if (el) el.style.transform = `translateY(${sink}px)`;
    },
    [],
  );

  const finishGesture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g || !g.locked) return;
      suppressClickRef.current = true;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      const dx = e.clientX - g.startX;
      const screenW = typeof window === "undefined" ? 9999 : window.innerWidth;
      const screenH = typeof window === "undefined" ? 9999 : window.innerHeight;
      const commitDist = screenW * COMMIT_DISTANCE_FRACTION;
      const sinkOut = (after: () => void) =>
        // Sink the whole sheet off the bottom (off-screen BEFORE onClose, so
        // vaul's own close animation plays invisibly), then reset for reopen.
        settle(screenH, () => {
          after();
          const el = contentRef.current;
          if (el) el.style.transform = "";
        });
      if (dx > commitDist || (dx > 0 && g.vx > COMMIT_VELOCITY_PX_S)) {
        // Swipe right → sink out + close.
        sinkOut(onClose);
      } else {
        settle(0);
      }
    },
    [onClose, settle],
  );

  const cancelGesture = useCallback(() => {
    const wasLocked = gestureRef.current?.locked ?? false;
    gestureRef.current = null;
    if (wasLocked) settle(0);
  }, [settle]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        ref={contentRef}
        className="max-h-[92vh] border-t-0 !bg-transparent"
        style={{
          background: "linear-gradient(180deg, hsla(0, 0%, 100%, 0.5) 0%, hsla(0, 0%, 100%, 0.7) 100%)",
          backdropFilter: "blur(40px) saturate(1.5)",
          WebkitBackdropFilter: "blur(40px) saturate(1.5)",
          border: "1px solid hsla(0, 0%, 100%, 0.4)",
          borderBottom: "none",
          borderRadius: "1.5rem 1.5rem 0 0",
        }}
        overlayClassName="!bg-foreground/5 backdrop-blur-[2px]"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>{card?.title ?? t("drawer.srTitleFallback")}</DrawerTitle>
          <DrawerDescription>{t("drawer.srDescription")}</DrawerDescription>
        </DrawerHeader>
        {card && (
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finishGesture}
            onPointerCancel={cancelGesture}
            onClickCapture={(e) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            // pan-y: the browser keeps vertical scrolling/dragging native,
            // horizontal movement is ours to interpret.
            style={{ touchAction: "pan-y" }}
          >
            <CardDrawerContent
              card={card}
              completed={completed}
              pending={pending}
              onExecute={onExecute}
              onClose={onClose}
              onDismiss={onDismiss}
              onComplete={onComplete}
              onChat={onChat}
            />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
