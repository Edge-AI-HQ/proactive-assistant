import { configureTransport } from "@pin-ai/core";

import { isPinLocalDevAuthEnabled, pinLocalDevAuthHeaders } from "./dev-auth";
import { ENV } from "./env";
import { supabase } from "./supabase";

async function authHeaders(): Promise<Record<string, string>> {
  if (isPinLocalDevAuthEnabled()) return pinLocalDevAuthHeaders();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function refreshAuth(): Promise<string | null> {
  if (isPinLocalDevAuthEnabled()) return null;
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

configureTransport({
  baseUrl: ENV.pinApiUrl,
  getAuthHeaders: authHeaders,
  refreshAuth,
});
