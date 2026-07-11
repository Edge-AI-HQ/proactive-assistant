import path from "node:path";
import { fileURLToPath } from "node:url";

// 设计 token SSOT（与 proactive-ai-frontend / apps/mobile 共享）。相对路径
// 直引而非包名：docker build 容器里 /app（本目录）的 npm install 不含
// workspace 包，而 ../../packages 在本地 monorepo 与容器 COPY packages/ →
// /packages 两种结构下都成立。
import { colors as sharedColors, borderRadius as sharedRadius, typeScale as sharedTypeScale, motion as sharedMotion } from "../../packages/design/tokens.cjs";

// 动效词汇表(S4):从 motion token 派生 transition duration / easing 工具类
// (duration-base / ease-standard 等),作为「简单状态过渡」这一档的标准,给后续
// 逐屏(S7)收编散落的 inline transition 用。复杂动效走 framer-motion(唯一 JS
// 交互动效库),signature 特效走 Skia——见 plan §六.4 三档约定。
const sharedTransitionDuration = Object.fromEntries(
  Object.entries(sharedMotion.duration).map(([key, ms]) => [key, `${ms}ms`]),
);
const sharedTransitionTimingFunction = Object.fromEntries(
  Object.entries(sharedMotion.easing).map(([key, bezier]) => [key, `cubic-bezier(${bezier.join(", ")})`]),
);

// 字号 scale：从 typeScale token 派生的 size-only tailwind 工具类(text-body 等),
// 给控件/容器/markdown 等非 Text-primitive 元素灭 text-[Npx] 魔法数。size-only
// (不带 lineHeight/letterSpacing)→ 与现状 text-[Npx] 逐值等价,不动 leading/tracking。
// 排除 display 档:`text-display` 会与 index.css 的 .text-display 复合排版类冲突,
// display 字号走 Text primitive 的 variant="display"。
const sharedFontSize = Object.fromEntries(
  Object.entries(sharedTypeScale)
    .filter(([key]) => key !== "display")
    .map(([key, v]) => [key, `${v.fontSize}px`]),
);

// content 用绝对路径：Tailwind v3 按 process.cwd() 解析相对 glob；绝对路径
// 在任何 cwd 下都成立。src/**（含 src/ui-web 功能层）的类名必须被扫到，
// 否则样式静默丢失。
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(here, "index.html"),
    path.join(here, "src/**/*.{ts,tsx}"),
    // ui-kit 的 cva 配方含 class 字面量（buttonVariants 等）—— 运行时 cva() 结果
    // 扫不到，必须静态覆盖 ui-kit 源码。
    path.join(here, "../../packages/ui-kit/src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        ...sharedColors,
        // secondary/destructive/accent/popover/input 已收编进 @pin-ai/design（随
        // sharedColors 引入）。此处仅保留 design 未收编的 apps/web 专属色。
        "cherub-end": "hsl(var(--cherub-end))",
      },
      borderRadius: sharedRadius,
      fontSize: sharedFontSize,
      transitionDuration: sharedTransitionDuration,
      transitionTimingFunction: sharedTransitionTimingFunction,
      keyframes: {
        "reflection-breath": {
          "0%, 100%": { boxShadow: "0 4px 18px rgba(225,92,230,0.10)", opacity: "0.94" },
          "50%": { boxShadow: "0 8px 28px rgba(225,92,230,0.22)", opacity: "1" },
        },
        // Subtle color breathing — text drifts toward purple and cools back
        // to neutral. Signals "ambient sensing active" without animating
        // any geometry (so it stays calm even on long-running pages).
        "ambient-drift": {
          "0%, 100%": { color: "hsl(var(--foreground) / 0.4)" },
          "50%": { color: "hsl(304 75% 55% / 0.7)" },
        },
        "green-breathe": {
          "0%, 100%": { color: "hsl(var(--foreground) / 0.45)" },
          "50%": { color: "hsl(160 84% 39% / 0.85)" },
        },
        // Emerald halo pulse radiating off the ambient toggle pill when on.
        "ambient-toggle-breathe": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(160 84% 39% / 0.35)" },
          "50%": { boxShadow: "0 0 0 8px hsl(160 84% 39% / 0)" },
        },
        // Subtler emerald halo pulse on the ambient icon circle when on.
        "ambient-icon-breathe": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(160 84% 39% / 0.35)" },
          "50%": { boxShadow: "0 0 0 6px hsl(160 84% 39% / 0)" },
        },
      },
      animation: {
        "reflection-breath": "reflection-breath 6s ease-in-out infinite",
        "ambient-drift": "ambient-drift 4s ease-in-out infinite",
        "green-breathe": "green-breathe 2.8s ease-in-out infinite",
        "ambient-toggle-breathe": "ambient-toggle-breathe 2s ease-out infinite",
        "ambient-icon-breathe": "ambient-icon-breathe 2.4s ease-out infinite",
      },
    },
  },
  plugins: [],
};
