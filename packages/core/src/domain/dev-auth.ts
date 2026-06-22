/**
 * Local-dev auth bypass constants — the wire SSOT shared by web
 * (proactive-ai-frontend), RN (apps/mobile) and the backend
 * (backend `auth/deps.py`). All three must agree on the header value and
 * synthetic user id; this used to be hand-copied in three places.
 *
 * The platform-specific enable guard (Vite `import.meta.env.DEV` vs RN
 * `__DEV__`) and the cast to a Supabase `User`/`Session` stay in each app's
 * `lib/dev-auth.ts` — only the protocol constants and the user field bag live
 * here so they cannot drift.
 */

export const PIN_LOCAL_DEV_AUTH_HEADER_VALUE = "pinai-local-dev-user";
export const PIN_LOCAL_DEV_AUTH_USER_ID = "00000000-0000-0000-0000-00000000d0d0";
export const PIN_LOCAL_DEV_AUTH_EMAIL = "dev-user@local.invalid";

/**
 * The synthetic dev user's fields. Each app casts the result to its
 * `@supabase/supabase-js` `User` (the cast — not the data — is what differs
 * per platform, so it stays in the app's adapter).
 */
export function pinLocalDevAuthUserFields() {
  return {
    id: PIN_LOCAL_DEV_AUTH_USER_ID,
    email: PIN_LOCAL_DEV_AUTH_EMAIL,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: { provider: "local-dev" },
    user_metadata: { full_name: "Local Dev User" },
    created_at: "2026-06-05T00:00:00.000Z",
  };
}
