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

function withGatewayAuth(init?: RequestInit): Record<string, string> {
  const token = window.__GW_TOKEN__;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = withGatewayAuth(init);
  return fetch(`${getApiRoot()}${path}`, { ...init, headers });
}

export function apiRpcFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = withGatewayAuth(init);
  return fetch(`${getApiRpcRoot()}${path}`, { ...init, headers });
}

export function apiPost(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiRpcPost(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return apiRpcFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
