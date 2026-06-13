/**
 * 排版换算层——web 与 RN 的单位制差异集中在这里：
 * - letterSpacing：web 是相对 em（tailwind tracking-tight=-0.025em、
 *   .text-display=-0.02em），RN 是绝对逻辑点，必须按字号换算。em 值现在取自
 *   @pin-ai/design 的 letterSpacingEm（三端 SSOT），不再手抄。
 * - lineHeight：web 是无单位倍数，RN 是绝对点，需显式换算，所有 Text 都该写
 *   显式 lineHeight（两端 half-leading 模型不同，依赖默认必漂）。
 */
import { letterSpacingEm } from "@pin-ai/design";

/** em 字距换算成 RN 绝对点。tracking(30, EM_TIGHT) 对应 web text-[30px] tracking-tight。 */
export const tracking = (fontSize: number, em: number): number => fontSize * em;

/** tailwind tracking-tight（值来自 @pin-ai/design SSOT）。 */
export const EM_TIGHT = letterSpacingEm.tight;
/** web .text-display 标题字距（@pin-ai/design SSOT）。 */
export const EM_DISPLAY = letterSpacingEm.display;

/** 无单位行高倍数换算成 RN 绝对点。leading(30, 1.05) 对应 web leading-[1.05]。 */
export const leading = (fontSize: number, ratio: number): number =>
  Math.round(fontSize * ratio);
