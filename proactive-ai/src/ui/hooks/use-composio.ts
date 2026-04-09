import { useState, useCallback, useEffect, useRef } from "react";
import { apiRpcFetch, apiRpcPost } from "@/lib/api";

export interface Connection {
  toolkit: string;
  status: string;
  connectedAccountId: string | null;
  userInfo: Record<string, unknown> | null;
}

export interface ComposioStatus {
  configured: boolean;
  keyPrefix?: string;
  source?: string;
  mode?: string;
}

export interface ComposioState {
  keyStatus: ComposioStatus | null;
  connections: Connection[];
  statusLoading: boolean;
  loadingConns: boolean;
  loadStatus: () => Promise<void>;
  loadConnections: () => Promise<Connection[]>;
  saveApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  connectToolkit: (toolkit: string) => Promise<{ ok: boolean; redirectUrl?: string; error?: string }>;
  disconnectAccount: (connectedAccountId: string) => Promise<{ ok: boolean; error?: string }>;
  waitForToolkit: (toolkit: string) => Promise<{ connected: boolean }>;
  cancelWait: () => void;
  isToolkitConnected: (toolkit: string) => boolean;
}

export function useComposio(): ComposioState {
  const [keyStatus, setKeyStatus] = useState<ComposioStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [loadingConns, setLoadingConns] = useState(false);

  const loadConnections = useCallback(async (): Promise<Connection[]> => {
    setLoadingConns(true);
    try {
      const res = await apiRpcFetch("/composio/connections");
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
      const res = await apiRpcFetch("/composio/status");
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

  const saveApiKey = useCallback(async (key: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await apiRpcPost("/composio/setup", { key });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error?.message ?? data.error ?? "Invalid key" };
      }
      // Reload status + connections after key saved
      await loadStatus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadStatus]);

  const connectToolkit = useCallback(async (toolkit: string): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> => {
    try {
      const res = await apiRpcPost("/composio/connect", { toolkit });
      const data = await res.json();
      if (data.status === "ACTIVE") {
        await loadConnections();
        return { ok: true };
      }
      if (data.redirectUrl) {
        return { ok: true, redirectUrl: data.redirectUrl };
      }
      return { ok: false, error: "No redirect URL returned" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadConnections]);

  const disconnectAccount = useCallback(async (connectedAccountId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await apiRpcPost("/composio/disconnect", { connectedAccountId });
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

  const waitForToolkit = useCallback(async (toolkit: string): Promise<{ connected: boolean }> => {
    waitAbortRef.current?.abort();
    const controller = new AbortController();
    waitAbortRef.current = controller;
    try {
      const res = await apiRpcPost("/composio/wait", { toolkit }, controller.signal);
      const data = await res.json();
      await loadConnections();
      const status = (data.status ?? "").toUpperCase();
      return { connected: status === "ACTIVE" };
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

  return { keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, saveApiKey, connectToolkit, disconnectAccount, waitForToolkit, cancelWait, isToolkitConnected };
}
