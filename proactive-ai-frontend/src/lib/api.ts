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

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 */
async function refreshAndGetToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

// ── APIs endpoints (/api/proactive/*) ──

export async function fetchMe(): Promise<{
  user: { id: string; email: string; name: string | null; avatar_url: string | null };
  container: { status: string; created_at: string } | null;
}> {
  const res = await fetch(`${API_BASE}/api/proactive/auth/me`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/auth/me failed: ${res.status}`);
  return res.json();
}

export async function heartbeat(): Promise<void> {
  await fetch(`${API_BASE}/api/proactive/user/heartbeat`, {
    method: "POST",
    headers: await authHeaders(),
  });
}

export async function ensureContainer(): Promise<{
  containerId: string;
  ready: boolean;
  status: string;
}> {
  const res = await fetch(`${API_BASE}/api/proactive/container/ensure`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/container/ensure failed: ${res.status}`);
  return res.json();
}

export async function destroyContainer(): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/api/proactive/container/destroy`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/container/destroy failed: ${res.status}`);
  return res.json();
}

export async function fetchContainerStatus(): Promise<{
  status: string;
  created_at?: string;
}> {
  const res = await fetch(`${API_BASE}/api/proactive/container/status`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/container/status failed: ${res.status}`);
  return res.json();
}

// ── Account deletion ──

export async function deleteAccount(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/proactive/user/account`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/user/account delete failed: ${res.status}`);
}

// ── Gateway ticket ──

export async function getGatewayTicket(): Promise<{
  ticket: string;
  expiresIn: number;
  url: string;
}> {
  const res = await fetch(`${API_BASE}/api/proactive/gateway/ticket`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`/gateway/ticket failed: ${res.status}`);
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
