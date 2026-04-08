export const API_ROOT = "/proactive-ai";
export const API_RPC_ROOT = "/proactive-ai/rpc";

declare global {
  interface Window {
    __GW_TOKEN__?: string;
    __GW_BASE_URL__?: string;
  }
}

function getApiRoot(): string {
  const gatewayBaseUrl = window.__GW_BASE_URL__?.replace(/\/+$/, "");
  return gatewayBaseUrl ? `${gatewayBaseUrl}${API_ROOT}` : API_ROOT;
}

function getApiRpcRoot(): string {
  const gatewayBaseUrl = window.__GW_BASE_URL__?.replace(/\/+$/, "");
  return gatewayBaseUrl ? `${gatewayBaseUrl}${API_RPC_ROOT}` : API_RPC_ROOT;
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
  // Map legacy /api/ paths to /rpc/ (server routes live under /proactive-ai/rpc/*)
  const rpcPath = path.replace(/^\/api\//, '/rpc/');
  return fetch(`${getApiRoot()}${rpcPath}`, { ...init, headers });
}

export function apiRpcFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  return fetch(`${getApiRpcRoot()}${path}`, { ...init, headers });
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
