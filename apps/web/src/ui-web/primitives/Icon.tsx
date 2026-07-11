import { cn, ICON_SIZE_PX, DEFAULT_ICON_STROKE_WIDTH } from "@pin-ai/ui-kit";
import type { IconProps, IconColor } from "@pin-ai/ui-kit";

/** 语义色 → token className（currentColor;lucide-react 图标默认 color=currentColor 继承）。 */
const COLOR_CLASS: Record<IconColor, string> = {
  foreground: "text-foreground",
  muted: "text-muted-foreground",
  primary: "text-primary",
  current: "",
};

/**
 * Icon primitive — web 实现。统一 size（语义档→px）/ strokeWidth;color 走 className
 * （currentColor,lucide-react 图标继承）。具体图标由调用方传入（lucide-react）。
 * RN 实现见 apps/mobile/src/primitives/Icon。
 */
export function Icon({
  icon: IconComp,
  size = "md",
  color = "current",
  strokeWidth = DEFAULT_ICON_STROKE_WIDTH,
  className,
}: IconProps) {
  return (
    <IconComp
      size={ICON_SIZE_PX[size]}
      strokeWidth={strokeWidth}
      className={cn(COLOR_CLASS[color], className)}
    />
  );
}
