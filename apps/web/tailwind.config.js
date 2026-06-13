import path from "node:path";
import { fileURLToPath } from "node:url";

// 设计 token SSOT（与 proactive-ai-frontend / apps/mobile 共享）。相对路径
// 直引而非包名：docker build 容器里 /app（本目录）的 npm install 不含
// workspace 包，而 ../../packages 在本地 monorepo 与容器 COPY packages/ →
// /packages 两种结构下都成立。
import { colors as sharedColors, borderRadius as sharedRadius } from "../../packages/design/tokens.cjs";

// content 用绝对路径：Tailwind v3 按 process.cwd() 解析相对 glob；绝对路径
// 在任何 cwd 下都成立（同 proactive-ai-frontend 的做法）。ui-web 共享组件
// 的类名必须被扫到，否则样式静默丢失。
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(here, "index.html"),
    path.join(here, "src/**/*.{ts,tsx}"),
    path.join(here, "../../packages/ui-web/src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        ...sharedColors,
        // zebra 桌面设计用到、design tokens 还没收编的扩展色（CSS 变量定义
        // 在 src/index.css :root，与原型仓对齐）。
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        input: "hsl(var(--input))",
        "cherub-end": "hsl(var(--cherub-end))",
      },
      borderRadius: sharedRadius,
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
