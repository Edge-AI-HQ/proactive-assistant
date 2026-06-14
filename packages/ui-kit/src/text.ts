import type { ReactNode } from "react";

import type { TypeScaleKey, FontWeightKey } from "@pin-ai/design";

/** Text 语义色（走 token className，双端通用）。随 color token 加厚扩展。 */
export type TextColor = "foreground" | "muted" | "primary";

/**
 * Text primitive 契约（双端共享，平台无关）。
 *
 * web 实现 = `packages/ui-web/src/primitives/Text`，
 * RN 实现 = `apps/mobile/src/primitives/Text`；两端读同一 typeScale / fontWeight
 * token 各自投影（字号/字重单位双端不同，由实现各自 style 投影）。
 * 设计 SSOT：docs/plans/2026-06-13-dual-platform-design-system.mdx。
 */
export interface TextProps {
  /** 字号语义档（typeScale）。默认 body。 */
  variant?: TypeScaleKey;
  /** 字重（双端投影 web=font-weight / RN=fontFamily）。默认 regular。 */
  weight?: FontWeightKey;
  /** 语义色。默认 foreground。 */
  color?: TextColor;
  /** 截断行数（web=line-clamp / RN=numberOfLines）;省略=不截断。 */
  numberOfLines?: number;
  /** 逃生舱：附加 className（仅限 NativeWind 双端通用子集）。 */
  className?: string;
  children?: ReactNode;
}
