import type { Session, User } from "@supabase/supabase-js";
import {
  PIN_LOCAL_DEV_AUTH_EMAIL,
  PIN_LOCAL_DEV_AUTH_HEADER_VALUE,
  PIN_LOCAL_DEV_AUTH_USER_ID,
  pinLocalDevAuthUserFields,
} from "@pin-ai/core";

// Protocol constants are the three-end SSOT in @pin-ai/core (web / RN /
// backend auth/deps.py); re-exported here so `@/lib/dev-auth` importers keep
// working. The enable guard and Supabase casts below are web-specific and stay.
export { PIN_LOCAL_DEV_AUTH_EMAIL, PIN_LOCAL_DEV_AUTH_HEADER_VALUE, PIN_LOCAL_DEV_AUTH_USER_ID };

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
  return pinLocalDevAuthUserFields() as User;
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
