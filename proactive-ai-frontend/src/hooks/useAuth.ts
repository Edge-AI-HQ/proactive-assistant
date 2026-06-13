/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web（测试随实现迁至
 * packages/ui-web/src/auth/useAuth.test.tsx）。旧路径 `@/hooks/useAuth`
 * 保持可用；新代码直接 import "@pin-ai/ui-web"。
 *
 * signOut 的 native 清理（clearDeviceCredentials）不再由 hook 内部硬依赖，
 * 改为 main.tsx 经 registerSignOutCleanup 注册（ui-web 不依赖重 native 模块）。
 */
export { useAuth } from "@pin-ai/ui-web";
