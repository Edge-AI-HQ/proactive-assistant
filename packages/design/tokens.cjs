/**
 * 设计 token 的 CJS 视图。给 require() 消费方（apps/mobile NativeWind config）
 * 与 Node-ESM 的命名导入（web/frontend tailwind.config 的 `import { colors }`）。
 *
 * 数据 SoT = tokens.json（改 token 值只改那里）。此处显式列名而非
 * `module.exports = require(...)`，是为了让 cjs-module-lexer 静态识别命名导出
 * （tailwind config 的 `import { colors, borderRadius }` 依赖它）。
 * Vite 源码 transform 不处理 .cjs 命名导出（会白屏）→ bundler 走 tokens.mjs。
 */
const t = require("./tokens.json");

module.exports = {
  colors: t.colors,
  borderRadius: t.borderRadius,
  cssVariables: t.cssVariables,
  letterSpacingEm: t.letterSpacingEm,
  typeScale: t.typeScale,
  fontWeight: t.fontWeight,
  motion: t.motion,
  elevation: t.elevation,
};
