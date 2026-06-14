import type { ComponentType } from "react";

/**
 * Icon primitive 契约（双端共享，平台无关）。统一图标 size / color / strokeWidth,
 * 消除散落的魔法数（现状 RN 满是 `size={16} color="#a1a1aa" strokeWidth={1.8}`）。
 *
 * 具体图标由调用方传入（web=lucide-react / RN=lucide-react-native 的图标组件,
 * 两者 props 结构都满足 IconComponent）。color 各端投影:web=className(currentColor,
 * 见 ui-web 实现)、RN=具体色值(lucide SVG 不被 NativeWind className 上色,见
 * apps/mobile 实现)。web 实现 = ui-web/primitives/Icon，RN 实现 = apps/mobile/primitives/Icon。
 */

/** lucide-react / lucide-react-native 图标的双端通用 props 形状。 */
export type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
}>;

export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

/** size 语义档 → px（双端共享数值）。 */
export const ICON_SIZE_PX: Record<IconSize, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
};

/** 语义色:current=继承上下文（web currentColor / RN lucide 默认）。 */
export type IconColor = "foreground" | "muted" | "primary" | "current";

/** lucide 默认 strokeWidth 2 偏粗,设计统一用 1.8。 */
export const DEFAULT_ICON_STROKE_WIDTH = 1.8;

export interface IconProps {
  /** 图标组件（web=lucide-react / RN=lucide-react-native）。 */
  icon: IconComponent;
  /** 尺寸语义档。默认 md（16px）。 */
  size?: IconSize;
  /** 语义色。默认 current（继承上下文）。 */
  color?: IconColor;
  /** 线宽。默认 1.8。 */
  strokeWidth?: number;
  /** 逃生舱（仅 web:RN lucide SVG 不吃 className）。 */
  className?: string;
}
