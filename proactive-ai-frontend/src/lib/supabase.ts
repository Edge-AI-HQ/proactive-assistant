import { createClient } from "@supabase/supabase-js";
import { isNative } from "./platform";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabasePublishableKey = import.meta.env
  .VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY environment variables",
  );
}

// Defaults from supabase-js (autoRefreshToken / persistSession /
// detectSessionInUrl all true) cover the SPA flow. Native overrides
// to PKCE so the OAuth code exchange happens server-side and tokens
// never appear in the deep-link URL.
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  ...(isNative && { auth: { flowType: "pkce" as const } }),
});
