import path from "node:path";
import { fileURLToPath } from "node:url";

import typography from "@tailwindcss/typography";
// 设计 token SSOT（与 apps/mobile 的 NativeWind 共享）。相对路径直引而非
// 包名：docker build 的容器里 /app（本目录）的 npm install 不含 workspace
// 包（@pin-ai/design 靠 root hoisting），而 ../packages 在两种结构下都
// 成立（本地 monorepo 平级 / 容器 COPY packages/ → /packages）。
import { colors as sharedColors, borderRadius as sharedRadius, letterSpacingEm as sharedLetterSpacingEm } from "../packages/design/tokens.cjs";

// content 用绝对路径：Tailwind v3 按 process.cwd() 解析相对 glob，web 构建
// （cwd=本目录）下没问题，但 Electron renderer（apps/desktop 为 cwd、root
// 指到这里）会解析到错误目录 → content 为空、样式全丢。
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(here, "index.html"),
    path.join(here, "src/**/*.{ts,tsx}"),
    path.join(here, "node_modules/@assistant-ui/react/**/*.{js,mjs}"),
  ],
  theme: {
    extend: {
      colors: sharedColors,
      borderRadius: sharedRadius,
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
