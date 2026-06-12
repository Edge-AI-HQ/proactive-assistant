/**
 * RN 环境配置（EXPO_PUBLIC_* 在 build 时 inline，与 web 的 VITE_* 同位）。
 * `make rn` 从 pinai-agents/.env 派生映射；缺失时入口 fail-fast。
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name} — run via \`make rn\` (derives env from pinai-agents/.env)`);
  }
  return value;
}

export const ENV = {
  supabaseUrl: required("EXPO_PUBLIC_SUPABASE_URL", process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabasePublishableKey: required(
    "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  pinApiUrl: required("EXPO_PUBLIC_PIN_API_URL", process.env.EXPO_PUBLIC_PIN_API_URL),
};
