// 共用层（packages/*）的依赖边界防墙 —— 前端版 trust boundary。
// 规则即架构：core 纯 TS、state 跨端 React（无 DOM）、平台实现只经 ports 注入。
// 设计 SSOT：research/2026-06-10-frontend-layering.mdx §3.1 / §4.5。
// 只覆盖 packages/*/src；proactive-ai-frontend 等 app 不在本配置范围内。
import tseslint from "typescript-eslint";

// 平台 globals 三端不同（web 有 window、RN 没有），共用层一律经 ports 注入。
const RESTRICTED_BROWSER_GLOBALS = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
].map((name) => ({
  name,
  message: `共用层禁止浏览器 global \`${name}\`：平台能力经 @pin-ai/core 的 ports 在各端入口注入。`,
}));

// 平台 SDK：web/Capacitor/Electron/RN 各自的实现包，共用层只定义接口。
const PLATFORM_IMPORT_PATTERNS = [
  {
    group: [
      "@capacitor/*",
      "@capacitor-community/*",
      "@capgo/*",
      "@aparajita/*",
      "@pin/capacitor-ambient-ai",
      "electron",
      "electron/*",
    ],
    message: "共用层禁止平台 SDK：实现放各端 app 的 adapter，经 ports 注入。",
  },
];

export default tseslint.config(
  {
    // @pin-ai/ui-web 是显式的 web 介质层（React DOM 组件 + 平台 hooks），
    // 浏览器 global 是它的本职，不适用跨端 globals 禁令；它有自己的边界
    // 规则（见下方 ui-web block）。其余共用包默认严格。
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    ignores: ["packages/ui-web/**"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-globals": ["error", ...RESTRICTED_BROWSER_GLOBALS],
    },
  },
  {
    // @pin-ai/core：纯 TS，连 react 都不进。
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...PLATFORM_IMPORT_PATTERNS,
            {
              group: ["react", "react/*", "react-dom", "react-dom/*"],
              message:
                "core 是纯 TS 层，禁止 React。业务编排 hooks 放 @pin-ai/state。",
            },
            {
              group: ["@pin-ai/state"],
              message: "依赖方向是 state→core，禁止反向 import。",
            },
          ],
        },
      ],
    },
  },
  {
    // @pin-ai/state：react-only（hooks），跨 React DOM / React Native。
    files: ["packages/state/src/**/*.ts", "packages/state/src/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...PLATFORM_IMPORT_PATTERNS,
            {
              group: ["react-dom", "react-dom/*", "react-native", "react-native/*"],
              message:
                "state 层跨 DOM/RN 共用，禁止渲染器与平台 UI 框架；只允许 react 本体的 hooks API。",
            },
          ],
        },
      ],
    },
  },
  {
    // @pin-ai/ui-web：web 介质共享层（proactive-ai-frontend 与 apps/web
    // 双端消费）。允许浏览器 globals 与 web-safe 的 @capacitor/core|browser|app；
    // 禁止重 native 插件（无 web 实现）与反向 import 两个 app。
    // 设计 SSOT：docs/plans/2026-06-12-zebra-web-app-port.mdx。
    files: ["packages/ui-web/src/**/*.ts", "packages/ui-web/src/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@capacitor-community/*",
                "@capgo/*",
                "@aparajita/*",
                "@pin/capacitor-ambient-ai",
                "@capacitor/push-notifications",
                "@capacitor/geolocation",
                "electron",
                "electron/*",
                "react-native",
                "react-native/*",
              ],
              message:
                "ui-web 依赖硬标准 =「纯 web 环境可运行」：重 native 插件不进 ui-web，触点经 props/注册点注入（如 registerSignOutCleanup），实现留各 app。",
            },
            {
              group: ["**/proactive-ai-frontend/**", "**/apps/web/**", "**/apps/mobile/**"],
              message: "ui-web 是被两个 app 消费的共享层，禁止反向 import app 代码。",
            },
          ],
        },
      ],
    },
  },
);
