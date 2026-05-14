import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function validHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const authConfigured = validHttpUrl(supabaseUrl) && Boolean(supabasePublishableKey);

export const supabase = authConfigured
  ? createClient(supabaseUrl as string, supabasePublishableKey as string)
  : null;

const TOKEN_REFRESH_SKEW_MS = 60_000;

export async function accessToken(): Promise<string | null> {
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;

  const expiresAtMs = session.expires_at ? session.expires_at * 1000 : 0;
  if (expiresAtMs && expiresAtMs - Date.now() < TOKEN_REFRESH_SKEW_MS) {
    return refreshAccessToken();
  }

  return session.access_token;
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const {
    data: { session },
  } = await supabase.auth.refreshSession();
  return session?.access_token ?? null;
}
