import { createClient } from "@supabase/supabase-js";
import { isElectron, isNative } from "./platform";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabasePublishableKey = import.meta.env
  .VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY environment variables",
  );
}

// Defaults from supabase-js (autoRefreshToken / persistSession /
// detectSessionInUrl all true) cover the SPA flow. Native and the
// Electron desktop shell override to PKCE so the deep-link callback
// carries `?code=` (exchanged in-app via exchangeCodeForSession) and
// tokens never appear in the URL — implicit flow would put
// `#access_token` in the callback, which the deep-link handler can't
// consume (it never reaches detectSessionInUrl in another window).
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  ...((isNative || isElectron) && { auth: { flowType: "pkce" as const } }),
});
