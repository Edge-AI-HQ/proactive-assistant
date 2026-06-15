/**
 * Browser login registry hooks —— agent 浏览器里"用户登录过的网站"的列表 +
 * 删除。数据走 web-local `/api/browser/logins`(读写 pai_browser_logins);
 * 删除会顺带清掉该站在 Browserbase Context 里的 cookie(后端 chat CDP)。
 *
 * 轻量 useState + useEffect + proxyFetch(与同目录 useBrowserSession 一致),
 * 不依赖 React Query / QueryClientProvider —— 这样在任意渲染上下文(含没有
 * QueryClient 的测试树)都能安全挂载。类型/normalize 在 @pin-ai/core。
 */
import { useCallback, useEffect, useState } from "react";

import { normalizeBrowserLogin, proxyFetch, type BrowserLogin } from "@pin-ai/core";

async function fetchBrowserLogins(): Promise<BrowserLogin[]> {
  const res = await proxyFetch("/browser/logins");
  if (!res.ok) throw new Error(`browser logins ${res.status}`);
  const body = (await res.json()) as { items?: unknown[] };
  return (body.items ?? [])
    .map(normalizeBrowserLogin)
    .filter((x): x is BrowserLogin => x !== null);
}

export interface UseBrowserLoginsResult {
  logins: BrowserLogin[];
  isLoading: boolean;
  error: unknown;
  /** Delete a site's saved login (also clears its cookies from the context). */
  deleteLogin: (siteDomain: string) => Promise<void>;
  /** Domain currently being deleted (for per-row spinner), or null. */
  deletingDomain: string | null;
  refetch: () => void;
}

export function useBrowserLogins(): UseBrowserLoginsResult {
  const [logins, setLogins] = useState<BrowserLogin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [deletingDomain, setDeletingDomain] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      setLogins(await fetchBrowserLogins());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchBrowserLogins();
        if (!cancelled) {
          setLogins(items);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const deleteLogin = useCallback(async (siteDomain: string) => {
    setDeletingDomain(siteDomain);
    try {
      const res = await proxyFetch(
        `/browser/logins/${encodeURIComponent(siteDomain)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`delete login ${res.status}`);
      // Optimistic removal; the row is gone server-side too.
      setLogins((prev) => prev.filter((l) => l.siteDomain !== siteDomain));
    } finally {
      setDeletingDomain(null);
    }
  }, []);

  return { logins, isLoading, error, deleteLogin, deletingDomain, refetch: load };
}
