/**
 * 设计 token 的 ESM 视图。给 bundler 消费（Vite alias `@pin-ai/design`）。
 *
 * 数据 SoT = tokens.json（改 token 值只改那里）。Vite dev 不对源码 .cjs 合成
 * 命名导出会整页白屏；ESM + JSON import 在 dev/prod 双通。CJS require 消费方
 * （apps/mobile NativeWind config / Node-ESM tailwind config）走 tokens.cjs。
 */
import t from "./tokens.json";

export const colors = t.colors;
export const borderRadius = t.borderRadius;
export const cssVariables = t.cssVariables;
export const letterSpacingEm = t.letterSpacingEm;
export const typeScale = t.typeScale;
export const fontWeight = t.fontWeight;
export const motion = t.motion;
export const elevation = t.elevation;

export default t;
