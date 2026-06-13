/**
 * 设计 token SSOT（web tailwind.config 与 apps/mobile NativeWind 共享）。
 * 色值用 CSS 变量引用（hsl(var(--x))），变量定义见 cssVariables（web 的
 * index.css :root 与 mobile 的 global.css :root 共用此块）。
 */
const colors = {
  background: "hsl(var(--background))",
  foreground: "hsl(var(--foreground))",
  card: {
    DEFAULT: "hsl(var(--card))",
    foreground: "hsl(var(--card-foreground))",
  },
  primary: {
    DEFAULT: "hsl(var(--primary))",
    foreground: "hsl(var(--primary-foreground))",
  },
  muted: {
    DEFAULT: "hsl(var(--muted))",
    foreground: "hsl(var(--muted-foreground))",
  },
  border: "hsl(var(--border))",
  ring: "hsl(var(--ring))",
};

const borderRadius = {
  lg: "var(--radius)",
  md: "calc(var(--radius) - 2px)",
  sm: "calc(var(--radius) - 4px)",
};

/** :root 变量块（与 proactive-ai-frontend/src/index.css 保持一致）。 */
const cssVariables = `
  --background: 220 30% 96%;
  --foreground: 230 25% 15%;
  --card: 0 0% 100%;
  --card-foreground: 230 25% 15%;
  --primary: 292 78% 63%;
  --primary-foreground: 0 0% 100%;
  --muted: 220 15% 90%;
  --muted-foreground: 220 10% 50%;
  --border: 220 20% 88%;
  --ring: 292 78% 63%;
  --radius: 1.25rem;
  --glass-bg: 0 0% 100% / 0.55;
  --glass-border: 0 0% 100% / 0.6;
  --glass-shadow: 280 20% 60% / 0.06;
  --glow-primary: 292 78% 63%;
  --glow-success: 145 60% 50%;
  --glow-warning: 35 90% 55%;
  --glow-alert: 0 72% 60%;
`;

// 自定义字距（em，相对字号）SSOT。web .text-display = -0.02em；tailwind
// tracking-tight 内置 -0.025em。RN letterSpacing 是绝对 pt，换算需要数值，
// 所以这里存数值，由 web tailwind（转 em 字符串）与 RN typography（直接用）共享。
const letterSpacingEm = {
  tight: -0.025,
  display: -0.02,
};

module.exports = { colors, borderRadius, cssVariables, letterSpacingEm };
