/**
 * Composio data connections hook for cloud frontend.
 * Adapted from proactive-ai/src/ui/hooks/use-composio.ts.
 * Routes all calls through proxyFetch/proxyPost.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { proxyFetch, proxyPost } from "@/lib/api";

/**
 * Backend-stable id of the per-(toolkit, connectedAccount) connector.init
 * row in `pai_scheduled_tasks`. Both /composio/connect→/wait and
 * /composio/reconnect upsert this same id (`requeue_once` /
 * `enqueue_once`), so the frontend can always reconstruct it without
 * threading a server-returned task id through component state. Used to let
 * any panel (DataConnections, DebugPanel) reattach polling after a refresh
 * — see useInitTask.
 *
 * Must stay in lockstep with `init_task_id()` in
 * pinai-agents/src/pinai_agents/web/routes/ui/composio.py.
 */
export function buildConnectorInitTaskId(toolkit: string, connectedAccountId: string): string {
  return `init.${toolkit.toLowerCase()}.${connectedAccountId}`;
}

const TOOLKIT_FANOUT: Record<string, string[]> = {
  googlesuper: ["gmail", "googlecalendar", "googledrive", "googledocs", "googlesheets"],
};

export function normalizeComposioToolkit(toolkit: string): string {
  return toolkit.trim().toLowerCase().replace(/[-_\s]/g, "");
}

export function composioToolkitCovers(connectionToolkit: string, targetToolkit: string): boolean {
  const connection = normalizeComposioToolkit(connectionToolkit);
  const target = normalizeComposioToolkit(targetToolkit);
  return connection === target || (TOOLKIT_FANOUT[connection] ?? []).includes(target);
}

export function getComposioConnectionsForToolkit<T extends { toolkit: string; status?: string }>(
  connections: T[],
  toolkit: string,
): T[] {
  const target = normalizeComposioToolkit(toolkit);
  return connections
    .filter((conn) => conn.status === "ACTIVE" && composioToolkitCovers(conn.toolkit, target))
    .sort((a, b) => {
      const aExact = normalizeComposioToolkit(a.toolkit) === target ? 0 : 1;
      const bExact = normalizeComposioToolkit(b.toolkit) === target ? 0 : 1;
      return aExact - bExact;
    });
}

export function isComposioToolkitConnected<T extends { toolkit: string; status?: string }>(
  connections: T[],
  toolkit: string,
): boolean {
  return getComposioConnectionsForToolkit(connections, toolkit).length > 0;
}

export interface Connection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  /** Backend-resolved display label (email / username / etc.). Always
   *  populated post-migration 040; backend falls back to a stable
   *  "toolkit (...{cid-suffix})" string if the identity action failed. */
  label: string | null;
  userInfo: Record<string, unknown> | null;
}

export interface ComposioStatus {
  /** True when the backend has a master Composio key configured. The key
   *  itself never reaches the browser — composio is multi-tenant on a
   *  single org-level key, scoped per user via Composio's user_id field. */
  configured: boolean;
  keyPrefix?: string;
}

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

  return { keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, loadCatalog, connectToolkit, disconnectAccount, waitForToolkit, cancelWait, isToolkitConnected, reconnectAccount, createCustomMcpConnector, updateCustomMcpConnector, deleteCustomMcpConnector };
}
