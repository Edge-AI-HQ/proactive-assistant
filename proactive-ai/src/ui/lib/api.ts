export const API_ROOT = "/proactive-ai";
export const API_RPC_ROOT = "/proactive-ai/rpc";

declare global {
  interface Window {
    __GW_TOKEN__?: string;
  }
}

function getAuthHeaders(): Record<string, string> {
  const token = window.__GW_TOKEN__;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  return fetch(`${API_ROOT}${path}`, { ...init, headers });
}

export function apiRpcFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  return fetch(`${API_RPC_ROOT}${path}`, { ...init, headers });
}

export function apiPost(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiRpcPost(path: string, body: unknown): Promise<Response> {
  return apiRpcFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
