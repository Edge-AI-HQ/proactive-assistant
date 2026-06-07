# Frontend 开发约束

继承项目根 AGENTS.md 所有规则。

## React
- 纯函数组件 + hooks，不用 class component，不引入 Redux/Zustand。
- Props 显式定义 interface。业务逻辑抽到 hooks/ 或 lib/，组件只管渲染和事件。

## 样式
- Tailwind utility classes 为主，自定义样式用 CSS 变量（index.css @layer base）。
- 类名合并用 `cn()`（lib/utils.ts）。不引入 CSS modules 或 CSS-in-JS。

## API
- 所有请求通过 `lib/api.ts` 封装，不在组件里直接 fetch。流式用 `proxySSE`。

## 导入与命名
- 用 `@/*` 别名。文件名分三类：组件 / class 文件 PascalCase（文件名 = 组件名 / 类名），hooks `use` 前缀 camelCase（文件名 = hook 名），其余工具 `.ts` 用 kebab-case（跨 OS 大小写安全，社区主流）。

## 平台
- 原生能力通过 Capacitor API，环境判断用 `lib/platform.ts`。
