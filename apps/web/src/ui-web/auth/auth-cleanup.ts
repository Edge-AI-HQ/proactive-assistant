/**
 * 过渡 shim —— signOut 清理注入点已下沉 @pin-ai/core(ports/sign-out-cleanup),
 * 平台无关,web/RN 共用。ui-web 内部消费(useAuth)+ app 注册点经此 shim 零改。
 */
export { registerSignOutCleanup, runSignOutCleanups, type SignOutCleanup } from "@pin-ai/core";
