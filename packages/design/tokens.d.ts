/**
 * Types for the design-token SSOT (tokens.cjs). Lets TS consumers (RN
 * typography, future Electron) import the tokens with types; the web
 * tailwind.config imports the .cjs directly and does not need these.
 */
export declare const colors: Record<string, unknown>;
export declare const borderRadius: Record<"lg" | "md" | "sm", string>;
export declare const cssVariables: string;
export declare const letterSpacingEm: { tight: number; display: number };

/** 字号梯度语义档（见 tokens.cjs 注释）。 */
export type TypeScaleKey =
  | "display"
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "bodySm"
  | "label"
  | "caption"
  | "micro";
export interface TypeScaleEntry {
  /** 逻辑像素。 */
  fontSize: number;
  /** 无单位倍数（×fontSize）。 */
  lineHeight: number;
  /** em（相对字号），由 primitive 换算成各端单位。 */
  letterSpacing: number;
}
export declare const typeScale: Record<TypeScaleKey, TypeScaleEntry>;

/** 字重语义键。 */
export type FontWeightKey = "regular" | "medium" | "semibold" | "bold";
/** 双端投影：web=CSS font-weight 数值，native=Inter 字体族名。 */
export interface FontWeightProjection {
  web: number;
  native: string;
}
export declare const fontWeight: Record<FontWeightKey, FontWeightProjection>;

/** 动效 token（duration 毫秒 / easing cubic-bezier 控制点 / spring 物理参数）。 */
export interface MotionTokens {
  duration: Record<"instant" | "fast" | "base" | "slow" | "slower", number>;
  easing: Record<"standard" | "decelerate" | "accelerate", [number, number, number, number]>;
  spring: { damping: number; stiffness: number; mass: number };
}
export declare const motion: MotionTokens;

/** 阴影梯度档（语义参数，双端各自投影）。 */
export type ElevationKey = "sm" | "md" | "lg";
export interface ElevationEntry {
  y: number;
  blur: number;
  opacity: number;
}
export declare const elevation: Record<ElevationKey, ElevationEntry>;
