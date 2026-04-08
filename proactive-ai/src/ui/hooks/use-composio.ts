import { useState, useCallback, useEffect } from "react";
import { apiRpcFetch, apiRpcPost } from "@/lib/api";

export interface Connection {
  toolkit: string;
  status: string;
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
  loadConnections: () => Promise<void>;
  saveApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  connectToolkit: (toolkit: string) => Promise<{ ok: boolean; redirectUrl?: string; error?: string }>;
  waitForToolkit: (toolkit: string) => Promise<void>;
}

export function useComposio(): ComposioState {
  const [keyStatus, setKeyStatus] = useState<ComposioStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [loadingConns, setLoadingConns] = useState(false);

  const loadConnections = useCallback(async () => {
    setLoadingConns(true);
    try {
      const res = await apiRpcFetch("/composio/connections");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setConnections(data.connections ?? []);
    } catch {
      setConnections([]);
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

  const waitForToolkit = useCallback(async (toolkit: string) => {
    try {
      await apiRpcPost("/composio/wait", { toolkit });
    } catch { /* best effort */ }
    await loadConnections();
  }, [loadConnections]);

  return { keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, saveApiKey, connectToolkit, waitForToolkit };
}
