import { ICON_SIZE_PX, DEFAULT_ICON_STROKE_WIDTH } from "@pin-ai/ui-kit";
import type { IconProps, IconColor } from "@pin-ai/ui-kit";

/**
 * 语义色 → 具体值。lucide-react-native 图标走 color prop（SVG 不被 NativeWind
 * className 上色,故 RN 在此投影;值对齐 design token light theme:foreground
 * `230 25% 15%` / muted-foreground `220 10% 50%` / primary `292 78% 63%`。dark theme
 * 待 RN theme 接入)。current=不传 → lucide 默认（currentColor）。
 */
const COLOR_VALUE: Record<IconColor, string | undefined> = {
  foreground: "hsl(230, 25%, 15%)",
  muted: "hsl(220, 10%, 50%)",
  primary: "hsl(292, 78%, 63%)",
  current: undefined,
};

/**
 * Icon primitive — RN 实现。统一 size（语义档→px）/ strokeWidth;color 投影成具体值
 * 传 lucide-react-native 图标的 color prop。具体图标由调用方传入（lucide-react-native）。
 * className 是 web 逃生舱,RN 不适用（lucide SVG 不吃 NativeWind className）。
 * web 实现见 packages/ui-web/src/primitives/Icon。
 */
export function Icon({
  icon: IconComp,
  size = "md",
  color = "current",
  strokeWidth = DEFAULT_ICON_STROKE_WIDTH,
}: IconProps) {
  return <IconComp size={ICON_SIZE_PX[size]} strokeWidth={strokeWidth} color={COLOR_VALUE[color]} />;
}
