/**
 * 过渡 shim —— 实现已下沉 @pin-ai/ui-web。旧路径 `@/lib/dev-auth` 保持
 * 可用；新代码直接 import "@pin-ai/ui-web"。
 */
export {
  isPinLocalDevAuthEnabled,
  pinLocalDevAuthHeaders,
  pinLocalDevAuthSession,
  pinLocalDevAuthUser,
  PIN_LOCAL_DEV_AUTH_HEADER_VALUE,
  PIN_LOCAL_DEV_AUTH_USER_ID,
  PIN_LOCAL_DEV_AUTH_EMAIL,
} from "@pin-ai/ui-web";
