/**
 * 本地开发 auth 旁路（RN 端）——web `lib/dev-auth.ts` 的同构镜像，常量
 * 与后端 `auth/deps.py` 的 dev bypass 对齐（仅 DEPLOY_ENV=dev 后端生效）。
 * 双保险：EXPO_PUBLIC_PIN_LOCAL_DEV_AUTH=1（构建时 inline）且 __DEV__
 * （release bundle 恒 false）——分发产物永不携带合成用户，与 web 用
 * import.meta.env.DEV 锁 vite build 同一设计。
 * 用途：模拟器/无真机时跳过 Google OAuth，直接进登录后页面做截图验收。
 */
import type { User } from "@supabase/supabase-js";

export const PIN_LOCAL_DEV_AUTH_HEADER_VALUE = "pinai-local-dev-user";
export const PIN_LOCAL_DEV_AUTH_USER_ID = "00000000-0000-0000-0000-00000000d0d0";
export const PIN_LOCAL_DEV_AUTH_EMAIL = "dev-user@local.invalid";

export function isPinLocalDevAuthEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PIN_LOCAL_DEV_AUTH === "1" && __DEV__;
}

export function pinLocalDevAuthHeaders(): Record<string, string> {
  return isPinLocalDevAuthEnabled()
    ? { "X-Dev-Auth": PIN_LOCAL_DEV_AUTH_HEADER_VALUE }
    : {};
}

export function pinLocalDevAuthUser(): User {
  return {
    id: PIN_LOCAL_DEV_AUTH_USER_ID,
    email: PIN_LOCAL_DEV_AUTH_EMAIL,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: { provider: "local-dev" },
    user_metadata: { full_name: "Local Dev User" },
    created_at: "2026-06-05T00:00:00.000Z",
  } as User;
}
