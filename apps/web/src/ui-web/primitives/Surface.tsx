import type { CSSProperties } from "react";

import { cn, surfaceVariants } from "@pin-ai/ui-kit";
import type { SurfaceProps } from "@pin-ai/ui-kit";
import { elevation as elevationTokens } from "@pin-ai/design";

/**
 * Surface primitive — web 实现（`<div>` / 可点击时 `<button>`）。
 *
 * 布局/背景/边框走 ui-kit `surfaceVariants` cva 配方;elevation 走 elevation token
 * 投影成 boxShadow;glass variant 用 backdrop-filter + glass cssVariables（web 介质）。
 * RN 实现见 apps/mobile/src/primitives/Surface（glass 用 expo-blur）。
 */
export function Surface({ variant, elevation, className, onPress, children }: SurfaceProps) {
  const v = variant ?? "solid";
  const style: CSSProperties = {};
  if (elevation) {
    const e = elevationTokens[elevation];
    style.boxShadow = `0 ${e.y}px ${e.blur}px rgba(0, 0, 0, ${e.opacity})`;
  }
  if (v === "glass") {
    style.background = "hsl(var(--glass-bg))";
    style.backdropFilter = "blur(16px)";
    style.WebkitBackdropFilter = "blur(16px)";
  }
  const cls = cn(surfaceVariants({ variant: v }), className);

  if (onPress) {
    return (
      <button type="button" onClick={onPress} className={cls} style={style}>
        {children}
      </button>
    );
  }
  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}
