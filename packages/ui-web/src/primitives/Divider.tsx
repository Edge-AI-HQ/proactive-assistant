import { cn, dividerVariants } from "@pin-ai/ui-kit";
import type { DividerProps } from "@pin-ai/ui-kit";

/**
 * Divider primitive — web 实现（`<div role="separator">`）。
 * 走与 RN 同一 `dividerVariants` cva 配方;色用 border token。
 * RN 实现见 apps/mobile/src/primitives/Divider。
 */
export function Divider({ orientation, className }: DividerProps) {
  return (
    <div
      role="separator"
      aria-orientation={orientation ?? "horizontal"}
      className={cn(dividerVariants({ orientation }), className)}
    />
  );
}
