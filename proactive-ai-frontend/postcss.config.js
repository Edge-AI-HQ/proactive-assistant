import path from "node:path";
import { fileURLToPath } from "node:url";

// tailwind config 用绝对路径显式传入：tailwindcss 的 PostCSS 插件默认按
// process.cwd() 找 ./tailwind.config.js，web 构建（cwd=本目录）没问题，
// Electron renderer（cwd=apps/desktop、root 指到这里）会找不到 config →
// 空 content、样式全丢。
const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: { config: path.join(here, "tailwind.config.js") },
    autoprefixer: {},
  },
};
