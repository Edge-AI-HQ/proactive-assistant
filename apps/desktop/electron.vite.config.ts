/**
 * Electron 三进程构建（分层方案 §3.2 apps/desktop）。
 *
 * renderer 直接复用 proactive-ai-frontend 的 Vite root（index.html + src/）
 * ——「一套 React DOM UI、两个壳」的最小实现：零文件搬迁，web app 即 UI
 * 真源。alias / stub 集合与 proactive-ai-frontend/vite.config.ts 保持一致
 * （web 端是 SSOT，改那边记得同步这里）。
 *
 * dev 模式 renderer 跑在 electron-vite 的 dev server 上，/api 走同源
 * proxy（与 web dev 完全一致，零 CORS）；打包件用 privileged scheme
 * `pinai://desktop` 加载静态文件 + VITE_PIN_API_URL 直连后端（后端
 * CORS_ALLOWED_ORIGINS 需含 `pinai://desktop`，照 capacitor://localhost
 * 模式）。
 */
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const frontendDir = path.resolve(__dirname, "../../proactive-ai-frontend");
const packagesDir = path.resolve(__dirname, "../../packages");

// 与 proactive-ai-frontend/vite.config.ts 的 web 分支一致：原生 Capacitor
// 包指到 Proxy stub（调用即 throw；isNative=false 下永不触发）。
const NATIVE_STUBBED_PACKAGES = [
  "@pin/capacitor-ambient-ai",
  "@capacitor-community/contacts",
  "@capacitor-community/sqlite",
  "@capacitor/geolocation",
  "@capacitor/push-notifications",
  "@capgo/capacitor-barometer",
  "@capgo/capacitor-health",
];

const rendererAliases = {
  "@": path.resolve(frontendDir, "src"),
  "@pin-ai/core": path.resolve(packagesDir, "core/src/index.ts"),
  "@pin-ai/state": path.resolve(packagesDir, "state/src/index.ts"),
  ...Object.fromEntries(
    NATIVE_STUBBED_PACKAGES.map((pkg) => [
      pkg,
      path.resolve(frontendDir, "src/lib/native-plugin-stub.ts"),
    ]),
  ),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: frontendDir,
    plugins: [react()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: rendererAliases,
    },
    server: {
      proxy: {
        // 与 web dev 同构：/api 同源代理到本地 compose 的 pinai-web（端口
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
        input: path.resolve(frontendDir, "index.html"),
      },
    },
  },
});
