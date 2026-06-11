# Frontend 开发约束

继承项目根 AGENTS.md 所有规则。分层架构 SSOT：`research/2026-06-10-frontend-layering.mdx`（core/state/apps 三层，web/Electron/RN 三端）。

## React 与状态
- 纯函数组件 + hooks，不用 class component。Props 显式定义 interface。组件只管渲染和事件。
- **server state 一律走 `@pin-ai/state` 的 TQ 域 hooks**（TanStack Query；QueryClient 在 `main.tsx` 提供，hook 迁移模式见 `packages/state/src/queries/memories.ts` 头注释）。不要再手写 useEffect+useState+轮询 的数据获取。
- 跨组件 client state 按分层方案用 zustand（随首个用例引入）。不引入 Redux。
- 跨端可共用的业务逻辑写进 `packages/`（core=纯 TS，state=React hooks），不要在 app 里新增只能 web 用的等价实现。

## API
- 后端调用一律走 `@pin-ai/core` 的域函数；流式用 `proxySSE` / `proxyGetSSE`。`lib/api.ts` 是过渡 shim（旧路径兼容），新代码直接 import `@pin-ai/core`。
- 不在组件里直接 fetch。auth/baseUrl/平台 headers 由 `lib/transport-bootstrap.ts` 注入，业务代码不碰。

## 样式
- Tailwind utility classes 为主，自定义样式用 CSS 变量（index.css @layer base）。
- 类名合并用 `cn()`（lib/utils.ts）。不引入 CSS modules 或 CSS-in-JS。

## 导入与命名
- 用 `@/*` 别名。文件名分三类：组件 / class 文件 PascalCase（文件名 = 组件名 / 类名），hooks `use` 前缀 camelCase（文件名 = hook 名），其余工具 `.ts` 用 kebab-case（跨 OS 大小写安全，社区主流）。

## 平台
- 原生能力通过 Capacitor API，环境判断用 `lib/platform.ts`；新代码优先「能力注入（ports）」而非散弹式 `isNative` 分支（分层方案 §4.5）。
