/**
 * Electron 三进程构建（分层方案 §3.2 apps/desktop）。
 *
 * renderer 复用 apps/web 的 Vite root（index.html + src/）——macOS app 以
 * zebra web 端为基础：「一套 zebra UI、web + 桌面两个壳」，apps/web 是 UI
 * 真源。alias 与 apps/web/vite.config.ts 保持一致（web 端是 SSOT，改那边
 * 记得同步这里）。
 *
 * dev：renderer 跑 electron-vite dev server，/api 走同源 proxy（与 web dev
 * 一致，零 CORS）。打包件用 privileged scheme `pinai://desktop` 服静态文件
 * + VITE_PIN_API_URL 直连后端（后端 CORS_ALLOWED_ORIGINS 需含
 * `pinai://desktop`，照 capacitor://localhost 模式）；apps/web 用
 * BrowserRouter，打包件的客户端路由靠 main 进程 protocol.handle 的 SPA
 * fallback（路由路径无文件 → index.html）兜底，刷新/深链不白屏。
 *
 * apps/web 是纯 web SPA（功能经 @pin-ai/core|state + UI 经 @pin-ai/ui-web），
 * 不依赖重 native 包（ambient/sqlite/geolocation 等），所以这里不需要
 * proactive-ai-frontend 那套 native-plugin-stub。
 */
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "node:path";

const webDir = path.resolve(__dirname, "../../apps/web");
const packagesDir = path.resolve(__dirname, "../../packages");

const rendererAliases = {
  "@": path.resolve(webDir, "src"),
  "@pin-ai/core": path.resolve(packagesDir, "core/src/index.ts"),
  "@pin-ai/state": path.resolve(packagesDir, "state/src/index.ts"),
  "@pin-ai/ui-web": path.resolve(packagesDir, "ui-web/src/index.ts"),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: webDir,
    plugins: [react()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: rendererAliases,
    },
    // electron-vite 的 cwd 是 apps/desktop，tailwind/postcss 默认按 cwd 找
    // config 会落空（apps/desktop 没有 tailwind.config.js），导致
    // apps/web/src/index.css 的 `@apply border-border` 等 token 工具类报
    // "class does not exist"。显式把 tailwind 指向 apps/web 的 config（web
    // 端是 SSOT），与 apps/web 独立 build 同源。
    css: {
      postcss: {
        plugins: [
          tailwindcss({ config: path.resolve(webDir, "tailwind.config.js") }),
          autoprefixer(),
        ],
      },
    },
    server: {
      proxy: {
        // 与 web dev 同构：/api 同源代理到本地 compose 的 api（端口
        // 随机，make urls 查后经 VITE_PIN_API_PROXY_TARGET 传入）。
        "/api": {
          target: process.env.VITE_PIN_API_PROXY_TARGET || "http://127.0.0.1:8000",
          ws: true,
          // make macos DEV=1/PROD=1 时 target 是 https fly——Host 必须随
          // target 改写，否则 fly 按 Host: localhost 路由失败。本地无害。
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(webDir, "index.html"),
      },
    },
  },
});
