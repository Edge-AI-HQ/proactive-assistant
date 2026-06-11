import type { Session, User } from "@supabase/supabase-js";

export const PIN_LOCAL_DEV_AUTH_HEADER_VALUE = "pinai-local-dev-user";
export const PIN_LOCAL_DEV_AUTH_USER_ID = "00000000-0000-0000-0000-00000000d0d0";
export const PIN_LOCAL_DEV_AUTH_EMAIL = "dev-user@local.invalid";

export function isPinLocalDevAuthEnabled(): boolean {
  // Local-dev auth is a convenience for the local web dev server only (Local
  // Hot mode, `npm run dev`). It must never activate in a built artifact —
  // a native Capacitor bundle (TestFlight / App Store) or a production web
  // build always uses real Supabase auth. `import.meta.env.DEV` is true only
  // on the Vite dev server and false for every `vite build` output, so this
  // guard keeps a stray VITE_PIN_LOCAL_DEV_AUTH=1 (e.g. leaked from a polluted
  // shell during a local build-ios.sh upload) from shipping the synthetic
  // "Local Dev User" into a distributed app.
  return import.meta.env.VITE_PIN_LOCAL_DEV_AUTH === "1" && import.meta.env.DEV;
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

export function pinLocalDevAuthSession(): Session {
  return {
    access_token: "pinai-local-dev-user",
    refresh_token: "pinai-local-dev-user",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: pinLocalDevAuthUser(),
  } as Session;
}
