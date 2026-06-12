/** NativeWind 的 tailwind 配置——theme token 来自 @pin-ai/design（与 web
 *  共享 SSOT），改色值改那边。 */
const { colors, borderRadius } = require("@pin-ai/design");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors,
      borderRadius,
      fontFamily: {
        sans: ["Inter_400Regular"],
        "sans-medium": ["Inter_500Medium"],
        "sans-semibold": ["Inter_600SemiBold"],
        "sans-bold": ["Inter_700Bold"],
        geist: ["Geist_400Regular"],
      },
    },
  },
  plugins: [],
};
