import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "./node_modules/@assistant-ui/react/**/*.{js,mjs}",
  ],
  theme: {
    extend: {
      colors: {
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
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
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
