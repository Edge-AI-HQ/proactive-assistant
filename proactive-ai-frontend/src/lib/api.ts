/**
 * API client for the proactive-ai cloud service.
 *
 * All calls go through the APIs reverse proxy:
 *   /api/proactive/*   → APIs endpoints (auth, container management)
 *   /api/proxy/*       → user's container (pipeline, chat, etc.)
 *
 * Auth: Supabase JWT is attached automatically via getAccessToken().
 */

import { supabase } from "./supabase";
import { API_BASE } from "./platform";

export interface Goal {
  id: string;
  user_id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRecord {
  id: string;
  user_id: string;
  display_name: string;
  locale: string;
  timezone: string;
  summary: string | null;
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileMemory {
  id: string;
  user_id: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

export interface ProfileSignal {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_key: string;
  value: number | null;
  source: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

export interface ProfileInterest {
  id: string;
  user_id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidence_count: number;
  status: string;
  last_signal_at: string | null;
}

export interface ProfileSnapshot {
  profile: ProfileRecord | null;
  goals: Goal[];
  memories: ProfileMemory[];
  signals: ProfileSignal[];
  interests: ProfileInterest[];
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status}`;

    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data?.error === "string" && data.error.trim()) {
        return `${res.status} ${data.error}`;
      }
    } catch {
      // Fall back to the raw response text when the body is not JSON.
    }

    return `${res.status} ${text}`;
  } catch {
    return `${res.status}`;
  }
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 */
async function refreshAndGetToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

async function proactiveFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status !== 401) return res;

  const freshToken = await refreshAndGetToken();
  if (!freshToken) return res;

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      Authorization: `Bearer ${freshToken}`,
    },
  });
}

// ── APIs endpoints (/api/proactive/*) ──

export async function fetchMe(): Promise<{
  user: { id: string; email: string; name: string | null; avatar_url: string | null };
  container: { status: string; created_at: string } | null;
}> {
  const res = await proactiveFetch("/api/proactive/auth/me");
  if (!res.ok) throw new Error(`/auth/me failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function heartbeat(): Promise<void> {
  await proactiveFetch("/api/proactive/user/heartbeat", {
    method: "POST",
  });
}

export async function ensureContainer(): Promise<{
  containerId: string;
  ready: boolean;
  status: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/ensure", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/ensure failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function destroyContainer(): Promise<{ ok: boolean }> {
  const res = await proactiveFetch("/api/proactive/container/destroy", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/destroy failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchContainerStatus(): Promise<{
  status: string;
  created_at?: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/status");
  if (!res.ok) throw new Error(`/container/status failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Account deletion ──

export async function deleteAccount(): Promise<void> {
  const res = await proactiveFetch("/api/proactive/user/account", {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`/user/account delete failed: ${await readErrorMessage(res)}`);
}

// ── Gateway ticket ──

export async function getGatewayTicket(): Promise<{
  ticket: string;
  expiresIn: number;
  url: string;
}> {
  const res = await proactiveFetch("/api/proactive/gateway/ticket", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/gateway/ticket failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Gateway readiness probe ──

export async function probeGatewayHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/proxy/health`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

// ── Container proxy endpoints (/api/proxy/*) ──

/**
 * Fetch via the container proxy.  Automatically retries once on 401
 * after refreshing the Supabase session token.
 */
export async function proxyFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers });

  // Retry once with a refreshed token on 401
  if (res.status === 401) {
    const freshToken = await refreshAndGetToken();
    if (freshToken) {
      const retryHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${freshToken}`,
      };
      return fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers: retryHeaders });
    }
  }

  return res;
}

export async function proxyPost(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return proxyFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function fetchProfileSnapshot(
  signal?: AbortSignal
): Promise<ProfileSnapshot> {
  const res = await proxyFetch("/profile", { signal });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);

  const data = await res.json();
  return {
    profile: data?.profile ?? null,
    goals: Array.isArray(data?.goals) ? data.goals : [],
    memories: Array.isArray(data?.memories) ? data.memories : [],
    signals: Array.isArray(data?.signals) ? data.signals : [],
    interests: Array.isArray(data?.interests) ? data.interests : [],
  };
}

/**
 * SSE stream from the container proxy.
 * Returns an async iterator of parsed JSON events.
 */
export async function* proxySSE<T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const res = await proxyPost(path, body, signal);
  if (!res.ok) throw new Error(`Proxy SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as T;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
