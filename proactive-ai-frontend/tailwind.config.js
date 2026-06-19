import path from "node:path";
import { fileURLToPath } from "node:url";

import typography from "@tailwindcss/typography";
// 设计 token SSOT（与 apps/mobile 的 NativeWind 共享）。相对路径直引而非
// 包名：docker build 的容器里 /app（本目录）的 npm install 不含 workspace
// 包（@pin-ai/design 靠 root hoisting），而 ../packages 在两种结构下都
// 成立（本地 monorepo 平级 / 容器 COPY packages/ → /packages）。
import { colors as sharedColors, borderRadius as sharedRadius, letterSpacingEm as sharedLetterSpacingEm, typeScale as sharedTypeScale, motion as sharedMotion } from "../packages/design/tokens.cjs";

// 动效词汇表(S4):从 motion token 派生 transition duration / easing 工具类
// (duration-base / ease-standard 等),作为「简单状态过渡」档的标准,给后续逐屏
// (S7)收编散落的 inline transition 用。复杂动效走 framer-motion,signature 走
// Skia——见 plan §六.4 三档约定。
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

// content 用绝对路径：Tailwind v3 按 process.cwd() 解析相对 glob，web 构建
// （cwd=本目录）下没问题，但 Electron renderer（apps/desktop 为 cwd、root
// 指到这里）会解析到错误目录 → content 为空、样式全丢。
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  // 触屏(iOS WKWebView)无 mouseleave 事件，`hover:` 状态会"粘滞"在最后点过的
  // 元素上直到点别处 → Setting 卡片等被卡在 hover 样式(看起来像一直被按住)。
  // 这个 flag 把所有 `hover:` 包进 @media (hover: hover)，只在真有指针的设备生效，
  // 触屏永不触发。Tailwind v4 已默认开启。
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: [
    path.join(here, "index.html"),
    path.join(here, "src/**/*.{ts,tsx}"),
    // 共享层 class 静态扫描。ui-web = 双端消费的 React DOM 组件层：不扫它，则
    // ui-web 专属的 arbitrary class（如 GoalDetailPopup 的 w-[600px]、各 primitive
    // 的字号/间距）在 frontend 不生成 → 组件在 web 显示错乱（弹层满屏 / 字号丢失 /
    // 文字出框）。ui-kit = cva 配方含 class 字面量（运行时 cva() 结果扫不到）。
    path.join(here, "../packages/ui-web/src/**/*.{ts,tsx}"),
    path.join(here, "../packages/ui-kit/src/**/*.{ts,tsx}"),
    path.join(here, "node_modules/@assistant-ui/react/**/*.{js,mjs}"),
  ],
  theme: {
    extend: {
      colors: sharedColors,
      borderRadius: sharedRadius,
      fontSize: sharedFontSize,
      transitionDuration: sharedTransitionDuration,
      transitionTimingFunction: sharedTransitionTimingFunction,
      // 字距 SSOT 来自 @pin-ai/design（与 RN typography 共享）。tracking-display
      // 对应 .text-display 的 -0.02em；tracking-tight 覆盖内置同值，保持单一真源。
      letterSpacing: {
        tight: `${sharedLetterSpacingEm.tight}em`,
        display: `${sharedLetterSpacingEm.display}em`,
      },
      keyframes: {
        // Subtle color breathing — text drifts toward purple and cools back
        // to neutral. Signals "ambient sensing active" without animating
        // any geometry (so it stays calm even on long-running pages).
        "ambient-drift": {
          "0%, 100%": { color: "hsl(var(--foreground) / 0.4)" },
          "50%":      { color: "hsl(304 75% 55% / 0.7)" },
        },
        // Emerald halo pulse radiating off the ambient toggle pill when on.
        "ambient-toggle-breathe": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(160 84% 39% / 0.35)" },
          "50%":      { boxShadow: "0 0 0 8px hsl(160 84% 39% / 0)" },
        },
        // Subtler emerald halo pulse on the ambient icon circle when on.
        "ambient-icon-breathe": {
          "0%, 100%": { boxShadow: "0 0 0 0 hsl(160 84% 39% / 0.35)" },
          "50%":      { boxShadow: "0 0 0 6px hsl(160 84% 39% / 0)" },
        },
      },
      animation: {
        "ambient-drift": "ambient-drift 4s ease-in-out infinite",
        "ambient-toggle-breathe": "ambient-toggle-breathe 2s ease-out infinite",
        "ambient-icon-breathe": "ambient-icon-breathe 2.4s ease-out infinite",
      },
    },
  },
  plugins: [typography],
};
