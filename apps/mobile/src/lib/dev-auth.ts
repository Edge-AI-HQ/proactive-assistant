/**
 * 本地开发 auth 旁路（RN 端）——协议常量与 synthetic user 字段现在从
 * @pin-ai/core 取（web / RN / 后端 auth/deps.py 的三端 SSOT，不再手抄）。
 * 平台差异留本文件：enable 判定（EXPO_PUBLIC_PIN_LOCAL_DEV_AUTH=1 构建时
 * inline 且 __DEV__，release bundle 恒 false，与 web import.meta.env.DEV 同
 * 设计）+ supabase User cast。
 * 用途：模拟器/无真机时跳过 Google OAuth，直接进登录后页面做截图验收。
 */
import type { User } from "@supabase/supabase-js";
import {
  PIN_LOCAL_DEV_AUTH_EMAIL,
  PIN_LOCAL_DEV_AUTH_HEADER_VALUE,
  PIN_LOCAL_DEV_AUTH_USER_ID,
  pinLocalDevAuthUserFields,
} from "@pin-ai/core";

export { PIN_LOCAL_DEV_AUTH_EMAIL, PIN_LOCAL_DEV_AUTH_HEADER_VALUE, PIN_LOCAL_DEV_AUTH_USER_ID };

export function isPinLocalDevAuthEnabled(): boolean {
  return process.env.EXPO_PUBLIC_PIN_LOCAL_DEV_AUTH === "1" && __DEV__;
}

export function pinLocalDevAuthHeaders(): Record<string, string> {
  return isPinLocalDevAuthEnabled()
    ? { "X-Dev-Auth": PIN_LOCAL_DEV_AUTH_HEADER_VALUE }
    : {};
}

export function pinLocalDevAuthUser(): User {
  return pinLocalDevAuthUserFields() as User;
}
