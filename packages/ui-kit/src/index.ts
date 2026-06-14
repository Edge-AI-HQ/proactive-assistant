// @pin-ai/ui-kit — 双端设计系统层（平台无关）。
// cn（className 工具）/ 组件契约（TS 类型）/ cva variant 配方 / motion 预设。
// apps/web 与 apps/mobile 共享同一份；禁止介质实现（DOM / RN / Web API）。
// 设计 SSOT：docs/plans/2026-06-13-dual-platform-design-system.mdx。

export { cn } from "./cn";

// ── 组件契约（primitive contracts）：类型单一真源，web/RN 各自实现渲染 ──
export type { TextProps, TextColor } from "./text";

// ── component 层：cva variant 配方（双端共享）+ 契约。web/RN 各自渲染实现 ──
export {
  buttonVariants,
  BUTTON_TEXT_COLOR,
  BUTTON_TEXT_VARIANT,
} from "./button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./button";
export { inputVariants } from "./input";
export type { InputProps, InputSize } from "./input";
export { surfaceVariants } from "./surface";
export type { SurfaceProps, SurfaceVariant } from "./surface";
