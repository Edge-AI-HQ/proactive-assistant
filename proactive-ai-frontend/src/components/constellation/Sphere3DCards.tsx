import { useEffect, useRef, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { isNative } from "@/lib/platform";

export type SphereCardStatus = "normal" | "new" | "processing" | "done";

export interface Sphere3DCardItem {
  id: number;
  category: string;
  title: string;
  icon: LucideIcon;
  categoryLabel: string;
  complexity?: "simple";
  status?: SphereCardStatus;
}

interface Props {
  items: Sphere3DCardItem[];
  /**
   * Optional fixed radius (px). If omitted, the component auto-fits to its
   * container, computing separate horizontal & vertical radii so the sphere
   * fills the available space (cards never escape the bounds).
   */
  radius?: number;
  /** Approximate card width — used by auto-fit so cards stay inside bounds. */
  cardWidth?: number;
  /** Approximate card height — used by auto-fit so cards stay inside bounds. */
  cardHeight?: number;
  onCardTap: (id: number) => void;
  cacheKey?: string;
}

interface RotState {
  yaw: number;
  pitch: number;
  velYaw: number;
  velPitch: number;
}

// Sphere-back cards stay visible (translucent) instead of being clipped at
// a hard threshold. Hiding the back half with opacity=0 made a 5-card feed
// look like it kept losing cards (2–5 visible as the user dragged the
// sphere). Front-most readability is handled by `surfaceAlpha` in the
// caller (0.55 → 0.95 boost for depth ≥ 0.6), so a linear opacity ramp
// is enough here.
export function getSphereCardPresentation(depth: number) {
  return {
    opacity: 0.32 + depth * 0.68,
    visible: true,
  };
}

// Module-level cache so rotation survives unmount/remount.
const rotationCache = new Map<string, RotState>();

/**
 * Distribute N points evenly on a unit sphere using a Fibonacci lattice.
 * Avoids the two poles (clamped to ±yMax) so points actually move under yaw.
 */
function fibonacciSphere(n: number) {
  const points: { x: number; y: number; z: number }[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
  // Wider band so points fill more of the vertical space, but still avoid
  // exact poles (which never move under yaw rotation).
  const yMax = 0.95;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const y = (1 - t * 2) * yMax;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    points.push({
      x: Math.cos(theta) * r,
      y,
      z: Math.sin(theta) * r,
    });
  }
  return points;
}

/**
 * 3D sphere of cards. User drags to rotate (X = yaw, Y = pitch).
 * Auto-rotates slowly when idle. Cards always face the camera for readability.
 */
const Sphere3DCards = ({
  items,
  radius,
  cardWidth = 160,
  cardHeight = 68,
  onCardTap,
  cacheKey,
}: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // Measure container so we can auto-fit the sphere to the available space.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setContainerSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Sphere center sits at 36% of the container height (was 21%, which clipped
  // top-half cards under overflow-hidden). Vertical radius can't simply be
  // `containerH/2 - halfH`; with the center pushed up, the top has less room
  // than the bottom, so we take the min of (centered, top-safe, bottom-safe).
  const sphereCenterTop = 0.36;
  // Compute horizontal & vertical radii so cards never escape the bounds.
  // Horizontal: front-most cards reach scale ≈ 1.1 → reserve full halfW.
  // Vertical: cards at top/bottom (y=±yMax) sit on the equator plane (z≈0),
  // so their depth is ~0.5 and scale ~0.83.
  const maxScale = 1.1;
  const polarScale = 0.83;
  const halfW = (cardWidth / 2) * maxScale;
  const halfH = (cardHeight / 2) * polarScale;
  const autoRx = Math.max(40, containerSize.w / 2 - halfW - 4);
  const verticalMargin = halfH + 4;
  const centeredRy = containerSize.h / 2 - halfH - 2;
  const topSafeRy = containerSize.h * sphereCenterTop - verticalMargin;
  const bottomSafeRy = containerSize.h * (1 - sphereCenterTop) - verticalMargin;
  const autoRy = containerSize.h > 0
    ? Math.max(1, Math.min(centeredRy, topSafeRy, bottomSafeRy))
    : 40;
  const rx = radius ?? autoRx;
  const ry = radius ?? autoRy;

  // Restore from cache if available, otherwise start at default pose.
  const initial = (cacheKey && rotationCache.get(cacheKey)) || {
    yaw: 0,
    pitch: -10,
    velYaw: 0.05,
    velPitch: 0,
  };
  const rotRef = useRef({ yaw: initial.yaw, pitch: initial.pitch });
  const velRef = useRef({ yaw: initial.velYaw, pitch: initial.velPitch });
  const draggingRef = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0, t: 0 });
  const [, force] = useState(0);
  const idleAnimationPaused = isNative;

  // Map id -> stable point index so adding/removing cards doesn't reshuffle
  // the whole sphere. Points are assigned in id order on first sight.
  const pointsRef = useRef<{ x: number; y: number; z: number }[]>([]);
  const idToPointIdx = useRef<Map<number, number>>(new Map());

  // Allocate enough points for current items + a little headroom
  const ensurePoints = (count: number) => {
    if (pointsRef.current.length < count) {
      pointsRef.current = fibonacciSphere(Math.max(count, 12));
    }
  };
  ensurePoints(items.length + 4);

  // Assign sphere slots to any new ids
  const assignedSlots = new Set(idToPointIdx.current.values());
  items.forEach((item) => {
    if (!idToPointIdx.current.has(item.id)) {
      // find first unused point index
      for (let i = 0; i < pointsRef.current.length; i++) {
        if (!assignedSlots.has(i)) {
          idToPointIdx.current.set(item.id, i);
          assignedSlots.add(i);
          break;
        }
      }
    }
  });

  const persistRotation = useCallback(() => {
    if (!cacheKey) return;
    rotationCache.set(cacheKey, {
      yaw: rotRef.current.yaw,
      pitch: rotRef.current.pitch,
      velYaw: velRef.current.yaw,
      velPitch: velRef.current.pitch,
    });
  }, [cacheKey]);

  // Animation loop — paused on native to avoid continuous WebKit/GPU work.
  useEffect(() => {
    if (idleAnimationPaused) {
      persistRotation();
      return;
    }
    let raf = 0;
    const tick = () => {
      if (!draggingRef.current) {
        rotRef.current.yaw += velRef.current.yaw;
        rotRef.current.pitch += velRef.current.pitch;
        velRef.current.yaw += (0.05 - velRef.current.yaw) * 0.015;
        velRef.current.pitch += (0 - velRef.current.pitch) * 0.04;
      }
      if (rotRef.current.pitch > 55) rotRef.current.pitch = 55;
      if (rotRef.current.pitch < -55) rotRef.current.pitch = -55;

      persistRotation();
      force((n) => (n + 1) % 1000000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idleAnimationPaused, persistRotation]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = true;
    lastPointer.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    velRef.current.yaw = 0;
    velRef.current.pitch = 0;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - lastPointer.current.x;
    const dy = e.clientY - lastPointer.current.y;
    // Yaw only — vertical drag is locked to prevent cards from overflowing
    // the container when the sphere tilts.
    rotRef.current.yaw += dx * 0.3;
    velRef.current.yaw = velRef.current.yaw * 0.7 + dx * 0.3 * 0.3;
    lastPointer.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (idleAnimationPaused) {
      persistRotation();
      force((n) => (n + 1) % 1000000);
    }
  }, [idleAnimationPaused, persistRotation]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    if (idleAnimationPaused) {
      persistRotation();
      force((n) => (n + 1) % 1000000);
    }
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }, [idleAnimationPaused, persistRotation]);

  // Apply yaw/pitch rotation to a unit vector
  const rotate = (p: { x: number; y: number; z: number }) => {
    const yaw = (rotRef.current.yaw * Math.PI) / 180;
    const pitch = (rotRef.current.pitch * Math.PI) / 180;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x = p.x * cy + p.z * sy;
    const z = -p.x * sy + p.z * cy;
    const y = p.y;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y2 = y * cp - z * sp;
    const z2 = y * sp + z * cp;
    return { x, y: y2, z: z2 };
  };

  const totalDragMoved = useRef(0);
  const dragStartXY = useRef({ x: 0, y: 0 });

  return (
    <div
      ref={containerRef}
      data-main-menu-swipe-ignore="true"
      className="relative w-full h-full select-none touch-none cursor-grab active:cursor-grabbing"
      onPointerDown={(e) => {
        dragStartXY.current = { x: e.clientX, y: e.clientY };
        totalDragMoved.current = 0;
        onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) {
          totalDragMoved.current +=
            Math.abs(e.clientX - lastPointer.current.x) +
            Math.abs(e.clientY - lastPointer.current.y);
        }
        onPointerMove(e);
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="absolute left-1/2"
        style={{
          // Sphere center driven by `sphereCenterTop` (declared above).
          // 36% keeps the front-hemisphere cards (pitched toward the lower
          // half by `pitch=-10°`) in the visual middle while leaving enough
          // room for the upper-hemisphere cards under overflow-hidden.
          // `autoRy` shrinks if the top has less margin than the bottom,
          // so the upper cap never gets clipped.
          top: `${sphereCenterTop * 100}%`,
          transform: "translate(-50%, -50%)",
          transformStyle: "preserve-3d",
          perspective: "1000px",
        }}
      >
        {items.map((item) => {
          const ptIdx = idToPointIdx.current.get(item.id);
          if (ptIdx === undefined) return null;
          const p = pointsRef.current[ptIdx];
          if (!p) return null;
          const rp = rotate(p);
          // Ellipsoid: separate horizontal & vertical radii so the sphere
          // fills the container without escaping its bounds. Depth uses the
          // smaller axis so scale/opacity stay perceptually consistent.
          const rDepth = Math.min(rx, ry);
          const x = rp.x * rx;
          const y = rp.y * ry;
          const z = rp.z * rDepth;
          const depth = (z + rDepth) / (2 * rDepth); // 0..1 (1 = front)
          const scale = 0.55 + depth * 0.55;
          const presentation = getSphereCardPresentation(depth);
          // Front-most cards get a brighter, more opaque surface for readability
          const frontBoost = Math.max(0, depth - 0.6) / 0.4; // 0..1 for depth 0.6..1
          const surfaceAlpha = 0.55 + frontBoost * 0.4; // 0.55 → 0.95
          const Icon = item.icon;
          const isFront = z > 0;
          const status = item.status ?? "normal";
          const isNew = status === "new";
          const isProcessing = status === "processing";
          const isDone = status === "done";

          const ringClass = isNew
            ? "ring-1 ring-pink-400/50"
            : isDone
            ? "ring-1 ring-green-400/50"
            : "";

          return (
            <button
              key={item.id}
              aria-hidden={!presentation.visible}
              tabIndex={presentation.visible ? 0 : -1}
              onClick={() => {
                if (totalDragMoved.current < 6) onCardTap(item.id);
              }}
              className={`absolute glass-card-strong px-2.5 py-2 text-left ${ringClass}`}
              style={{
                left: 0,
                top: 0,
                width: 160,
                background: `hsl(var(--card) / ${surfaceAlpha.toFixed(2)})`,
                // Keep subpixel translation (rounding causes 1px jumps when
                // velocity < 1px/frame). Force a stable GPU layer so text
                // stays cached and doesn't re-rasterize each frame.
                transform: `translate3d(${(x - 80).toFixed(2)}px, ${(y - 34).toFixed(2)}px, 0) scale(${scale.toFixed(3)})`,
                opacity: Math.round(presentation.opacity * 100) / 100,
                zIndex: Math.round(1000 + z),
                pointerEvents: depth < 0.25 ? "none" : "auto",
                borderRadius: 14,
                boxShadow: isFront ? "0 4px 18px rgba(0,0,0,0.12)" : "none",
                transition: draggingRef.current ? "none" : "box-shadow 0.2s, opacity 0.2s",
                willChange: idleAnimationPaused ? "auto" : "transform",
                backfaceVisibility: "hidden",
                WebkitBackfaceVisibility: "hidden",
                transformStyle: "preserve-3d",
                WebkitFontSmoothing: "antialiased",
                MozOsxFontSmoothing: "grayscale",
              }}
            >
              <div className="flex items-center gap-1 mb-1">
                {item.complexity === "simple" ? (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-[1px] rounded-full uppercase tracking-wide leading-none"
                    style={{ background: "rgba(225,92,230,0.15)", color: "#E15CE6" }}
                  >
                    <span className="w-1 h-1 rounded-full" style={{ background: "#E15CE6" }} />
                    Quick
                  </span>
                ) : (
                  <>
                    <Icon size={12} strokeWidth={1.5} className="text-foreground/60 shrink-0" />
                    <span className="text-[10px] font-semibold tracking-wide text-foreground/60 uppercase truncate">
                      {item.categoryLabel}
                    </span>
                  </>
                )}
                {isNew && (
                  <span className="text-[10px] font-bold text-pink-500 uppercase tracking-wider ml-auto">
                    new
                  </span>
                )}
                {isProcessing && (
                  <span className="ml-auto shrink-0 w-2.5 h-2.5 rounded-full border-[1.5px] border-amber-400 border-t-transparent animate-spin" />
                )}
                {isDone && (
                  <span className="text-[10px] font-bold text-green-500 uppercase tracking-wider ml-auto">
                    done
                  </span>
                )}
              </div>
              <p className="text-[13px] font-medium text-foreground leading-snug line-clamp-3">
                {item.title}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default Sphere3DCards;
