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

export interface Connection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  userInfo: Record<string, unknown> | null;
}

export interface ComposioStatus {
  /** True when the backend has a master Composio key configured. The key
   *  itself never reaches the browser — composio is multi-tenant on a
   *  single org-level key, scoped per user via Composio's user_id field. */
  configured: boolean;
  keyPrefix?: string;
}

export interface ComposioState {
  keyStatus: ComposioStatus | null;
  connections: Connection[];
  statusLoading: boolean;
  loadingConns: boolean;
  loadStatus: () => Promise<void>;
  loadConnections: () => Promise<Connection[]>;
  connectToolkit: (toolkit: string) => Promise<{ ok: boolean; redirectUrl?: string; connectedAccountId?: string; error?: string }>;
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

  const connectToolkit = useCallback(async (toolkit: string): Promise<{ ok: boolean; redirectUrl?: string; connectedAccountId?: string; error?: string }> => {
    try {
      const res = await proxyPost("/composio/connect", { toolkit });
      const data = await res.json();
      const connectedAccountId = data.connectedAccountId ?? undefined;
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
    return connections.some(
      c => c.toolkit.toLowerCase() === toolkit.toLowerCase() && c.status === "ACTIVE",
    );
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

  return { keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, connectToolkit, disconnectAccount, waitForToolkit, cancelWait, isToolkitConnected, reconnectAccount };
}
