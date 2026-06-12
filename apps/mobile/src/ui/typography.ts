/**
 * 排版换算层——web↔RN 的单位制差异集中在这里：
 * - letterSpacing：web 是相对 em（tailwind tracking-tight=-0.025em、
 *   .text-display=-0.02em），RN 是绝对逻辑点 → 必须按字号换算。
 * - lineHeight：web 是无单位倍数，RN 是绝对点 → 显式换算，所有 Text
 *   都该写显式 lineHeight（两端 half-leading 模型不同，依赖默认必漂）。
 */

/** em 字距 → RN 绝对点。`tracking(30, EM_TIGHT)` ≙ web `text-[30px] tracking-tight`。 */
export const tracking = (fontSize: number, em: number): number => fontSize * em;

/** tailwind `tracking-tight` */
export const EM_TIGHT = -0.025;
/** web `.text-display` 标题字距 */
export const EM_DISPLAY = -0.02;

/** 无单位行高倍数 → RN 绝对点。`leading(30, 1.05)` ≙ web `leading-[1.05]`。 */
export const leading = (fontSize: number, ratio: number): number =>
  Math.round(fontSize * ratio);
