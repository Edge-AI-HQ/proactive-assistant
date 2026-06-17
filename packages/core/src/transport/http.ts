import { getTransportConfig, resolveFetch } from "./config";

/** 组装一次请求的完整 headers：平台默认 → auth → 调用方覆盖。 */
async function buildHeaders(
  initHeaders?: HeadersInit,
): Promise<Record<string, string>> {
  const cfg = getTransportConfig();
  return {
    ...(cfg.defaultHeaders ?? {}),
    ...(await cfg.getAuthHeaders()),
    ...((initHeaders as Record<string, string>) ?? {}),
  };
}

/**
 * 401 时刷新 auth 并重试一次。刷新拿不到新 token、或重试后仍 401，说明
 * session 不可恢复（refresh token 失效/被 revoke），触发 onAuthInvalid 让
 * 平台层全局收口（清态回登录页）；未注入该回调则退化为返回原 401。
 */
async function fetchWithAuthRetry(
  url: string,
  init: RequestInit | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const fetchImpl = resolveFetch();
  const res = await fetchImpl(url, { ...init, headers });
  if (res.status !== 401) return res;

  const cfg = getTransportConfig();
  if (!cfg.refreshAuth) return res;
  const freshToken = await cfg.refreshAuth();
  if (!freshToken) {
    cfg.onAuthInvalid?.();
    return res;
  }

  const retried = await fetchImpl(url, {
    ...init,
    headers: { ...headers, Authorization: `Bearer ${freshToken}` },
  });
  if (retried.status === 401) cfg.onAuthInvalid?.();
  return retried;
}

/** 裸路径请求（path 自带前缀，如 `/api/devices/list`、`/health`）。 */
export async function pinaiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = await buildHeaders(init?.headers);
  return fetchWithAuthRetry(`${getTransportConfig().baseUrl}${path}`, init, headers);
}

/** `/api/*` 请求：`proxyFetch(path)` → `${baseUrl}/api${path}`。
 * 名字保留是为了调用方可读性——所有 UI 调用走同一个 helper。 */
export async function proxyFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = await buildHeaders(init?.headers);
  return fetchWithAuthRetry(
    `${getTransportConfig().baseUrl}/api${path}`,
    init,
    headers,
  );
}

export async function proxyPost(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return proxyFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
