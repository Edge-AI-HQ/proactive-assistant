/**
 * Composio data connections hook (web).
 * Toolkit-matching, identity heuristics and shared types now live in
 * @pin-ai/core (domain/composio); this file keeps the React hook + its
 * web-only action surface (catalog / custom-MCP / wait) and re-exports the
 * pure helpers so existing `@/hooks/useComposio` importers are unaffected.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildConnectorInitTaskId,
  buildConnectorPreviewTaskId,
  composioToolkitCovers,
  getComposioConnectionsForToolkit,
  isComposioToolkitConnected,
  normalizeComposioToolkit,
  proxyFetch,
  proxyPost,
  type ComposioConnection,
  type ComposioStatus,
} from "@pin-ai/core";

// Re-export pure helpers + shared types from core so `@/hooks/useComposio`
// stays a stable import surface for existing consumers.
export {
  buildConnectorInitTaskId,
  buildConnectorPreviewTaskId,
  composioToolkitCovers,
  getComposioConnectionsForToolkit,
  isComposioToolkitConnected,
  normalizeComposioToolkit,
};
export type { ComposioConnection, ComposioStatus };

// Pure toolkit-matching helpers + shared types (Connection / ComposioStatus)
// moved to @pin-ai/core (domain/composio); imported + re-exported above.
// `Connection` keeps its old name here as an alias so the 11 consumers and the
// hook body below are untouched.
export type Connection = ComposioConnection;

export interface ComposioCatalogItem {
  slug: string;
  name: string;
  logo: string | null;
  categories: string[];
  auth_schemes: string[];
  is_composio_managed: boolean;
}

export interface ComposioCatalogPage {
  items: ComposioCatalogItem[];
  nextCursor: string | null;
  totalCount: number | null;
}

export type ComposioCustomAuthScheme = "OAUTH2" | "API_KEY" | "BEARER_TOKEN" | "BASIC";

export interface ComposioCustomAuthConfig {
  authScheme: ComposioCustomAuthScheme;
  credentials: Record<string, string>;
}

export interface ConnectToolkitOptions {
  authConfig?: ComposioCustomAuthConfig;
}

export interface CustomMcpConnector {
  id: string;
  slug: string;
  name: string;
  url: string;
  rawSources?: Array<{ toolkit: string; entity: string }>;
}

export interface CustomMcpConnectorResult {
  ok: boolean;
  connector?: CustomMcpConnector;
  fetched?: number;
  rawInserted?: number;
  evolveTaskId?: string;
  error?: string;
}

export interface ComposioState {
  keyStatus: ComposioStatus | null;
  connections: Connection[];
  statusLoading: boolean;
  loadingConns: boolean;
  loadStatus: () => Promise<void>;
  loadConnections: () => Promise<Connection[]>;
  loadCatalog: (opts?: { category?: string; query?: string; cursor?: string; limit?: number }) => Promise<{ ok: boolean; page?: ComposioCatalogPage; error?: string }>;
  connectToolkit: (toolkit: string, options?: ConnectToolkitOptions) => Promise<{ ok: boolean; redirectUrl?: string; connectedAccountId?: string; error?: string }>;
  disconnectAccount: (connectedAccountId: string) => Promise<{ ok: boolean; error?: string }>;
  waitForToolkit: (connectedAccountId: string) => Promise<{ connected: boolean; initTaskId?: string }>;
  cancelWait: () => void;
  isToolkitConnected: (toolkit: string) => boolean;
  /** Trigger a fresh connector.init for an existing ACTIVE account.
   * Bypasses the v1 idempotency key (key includes a timestamp) so the
   * pipeline re-pulls 100 items, re-derives signals, and re-runs evolve.
   * Existing raw / signal rows are NOT deleted — dedupe absorbs.
   * Returns the new task id so the caller can poll progress. */
  reconnectAccount: (toolkit: string, connectedAccountId: string) => Promise<{ ok: boolean; initTaskId?: string; error?: string }>;
  createCustomMcpConnector: (input: {
    name: string;
    url: string;
  }) => Promise<CustomMcpConnectorResult>;
  updateCustomMcpConnector: (connectorId: string, input: {
    name: string;
    url: string;
  }) => Promise<CustomMcpConnectorResult>;
  deleteCustomMcpConnector: (connectorId: string) => Promise<{ ok: boolean; error?: string }>;
}

export function useComposio(): ComposioState {
  const [keyStatus, setKeyStatus] = useState<ComposioStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [loadingConns, setLoadingConns] = useState(false);

  const loadConnections = useCallback(async (): Promise<Connection[]> => {
    setLoadingConns(true);
    try {
      const res = await proxyFetch("/composio/connections");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const conns: Connection[] = data.connections ?? [];
      setConnections(conns);
      return conns;
    } catch {
      setConnections([]);
      return [];
    } finally {
      setLoadingConns(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatusLoading(true);
      const res = await proxyFetch("/composio/status");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setKeyStatus(data);
      if (data.configured) await loadConnections();
    } catch {
      setKeyStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, [loadConnections]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadCatalog = useCallback(async (
    opts: { category?: string; query?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ ok: boolean; page?: ComposioCatalogPage; error?: string }> => {
    try {
      const params = new URLSearchParams();
      if (opts.category) params.set("category", opts.category);
      if (opts.query) params.set("query", opts.query);
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.limit) params.set("limit", String(opts.limit));
      const query = params.toString();
      const res = await proxyFetch(`/composio/catalog${query ? `?${query}` : ""}`);
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.detail ?? data.error?.message ?? data.error ?? `Catalog failed (${res.status})` };
      }
      return {
        ok: true,
        page: {
          items: data.items ?? [],
          nextCursor: data.nextCursor ?? null,
          totalCount: typeof data.totalCount === "number" ? data.totalCount : null,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const connectToolkit = useCallback(async (
    toolkit: string,
    options: ConnectToolkitOptions = {},
  ): Promise<{ ok: boolean; redirectUrl?: string; connectedAccountId?: string; error?: string }> => {
    try {
      const res = await proxyPost("/composio/connect", {
        toolkit,
        ...(options.authConfig ? { authConfig: options.authConfig } : {}),
      });
      const data = await res.json();
      const connectedAccountId = data.connectedAccountId ?? undefined;
      if (!res.ok) {
        return { ok: false, error: data.detail ?? data.error?.message ?? data.error ?? `Connect failed (${res.status})` };
      }
      if (data.status === "ACTIVE") {
        await loadConnections();
        return { ok: true, connectedAccountId };
      }
      if (data.redirectUrl) {
        return { ok: true, redirectUrl: data.redirectUrl, connectedAccountId };
      }
      return { ok: false, error: "No redirect URL returned" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  const disconnectAccount = useCallback(async (connectedAccountId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await proxyPost("/composio/disconnect", { connectedAccountId });
      if (!res.ok) {
        const data = await res.json();
        return { ok: false, error: data.error?.message ?? data.error ?? "Disconnect failed" };
      }
      await loadConnections();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  const waitAbortRef = useRef<AbortController | null>(null);

  const waitForToolkit = useCallback(async (connectedAccountId: string): Promise<{ connected: boolean; initTaskId?: string }> => {
    waitAbortRef.current?.abort();
    const controller = new AbortController();
    waitAbortRef.current = controller;
    try {
      const res = await proxyPost("/composio/wait", { connectedAccountId }, controller.signal);
      const data = await res.json();
      await loadConnections();
      const status = (data.status ?? "").toUpperCase();
      // initTaskId is only present when the backend's task scheduler is on.
      // When off, the field is absent and the caller skips progress polling
      // — connector card behaves like the pre-Phase-B UI.
      const initTaskId = typeof data.initTaskId === "string" ? data.initTaskId : undefined;
      return { connected: status === "ACTIVE", initTaskId };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { connected: false };
      }
      await loadConnections();
      return { connected: false };
    } finally {
      if (waitAbortRef.current === controller) waitAbortRef.current = null;
    }
  }, [loadConnections]);

  const cancelWait = useCallback(() => {
    waitAbortRef.current?.abort();
    waitAbortRef.current = null;
  }, []);

  const isToolkitConnected = useCallback((toolkit: string): boolean => {
    return isComposioToolkitConnected(connections, toolkit);
  }, [connections]);

  const reconnectAccount = useCallback(async (
    toolkit: string,
    connectedAccountId: string,
  ): Promise<{ ok: boolean; initTaskId?: string; error?: string }> => {
    try {
      const res = await proxyPost("/composio/reconnect", { toolkit, connectedAccountId });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error?.message ?? data.error ?? `Reconnect failed (${res.status})` };
      }
      const data = await res.json();
      const initTaskId = typeof data.initTaskId === "string" ? data.initTaskId : undefined;
      return { ok: true, initTaskId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, []);

  const createCustomMcpConnector = useCallback(async (input: {
    name: string;
    url: string;
  }): Promise<CustomMcpConnectorResult> => {
    try {
      const res = await proxyPost("/composio/custom-mcp", input);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.detail ?? data.error?.message ?? data.error ?? `Custom connector failed (${res.status})` };
      }
      await loadConnections();
      return {
        ok: true,
        connector: data.connector,
        fetched: typeof data.fetched === "number" ? data.fetched : undefined,
        rawInserted: typeof data.rawInserted === "number" ? data.rawInserted : undefined,
        evolveTaskId: typeof data.evolveTaskId === "string" ? data.evolveTaskId : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  const updateCustomMcpConnector = useCallback(async (connectorId: string, input: {
    name: string;
    url: string;
  }): Promise<CustomMcpConnectorResult> => {
    try {
      const res = await proxyFetch(`/composio/custom-mcp/${encodeURIComponent(connectorId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.detail ?? data.error?.message ?? data.error ?? `Custom connector update failed (${res.status})` };
      }
      await loadConnections();
      return {
        ok: true,
        connector: data.connector,
        fetched: typeof data.fetched === "number" ? data.fetched : undefined,
        rawInserted: typeof data.rawInserted === "number" ? data.rawInserted : undefined,
        evolveTaskId: typeof data.evolveTaskId === "string" ? data.evolveTaskId : undefined,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  const deleteCustomMcpConnector = useCallback(async (connectorId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await proxyFetch(`/composio/custom-mcp/${encodeURIComponent(connectorId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.detail ?? data.error?.message ?? data.error ?? `Delete failed (${res.status})` };
      }
      await loadConnections();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  // 返回对象 memo 化：所有字段本就稳定（useState 值 + useCallback 函数），包一层
  // useMemo 让对象身份只在字段真变时才变——消费端（把它当 prop / context 依赖下发）
  // 才能用 React.memo 截断无关重渲。行为不变，纯身份稳定。
  return useMemo(
    () => ({ keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, loadCatalog, connectToolkit, disconnectAccount, waitForToolkit, cancelWait, isToolkitConnected, reconnectAccount, createCustomMcpConnector, updateCustomMcpConnector, deleteCustomMcpConnector }),
    [keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, loadCatalog, connectToolkit, disconnectAccount, waitForToolkit, cancelWait, isToolkitConnected, reconnectAccount, createCustomMcpConnector, updateCustomMcpConnector, deleteCustomMcpConnector],
  );
}
