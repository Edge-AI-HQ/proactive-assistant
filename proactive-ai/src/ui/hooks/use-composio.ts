import { useState, useCallback, useEffect } from "react";
import { apiFetch, apiPost } from "@/lib/api";

export interface Connection {
  toolkit: string;
  status: string;
}

export interface ComposioStatus {
  configured: boolean;
  keyPrefix?: string;
  source?: string;
}

export interface ComposioState {
  keyStatus: ComposioStatus | null;
  connections: Connection[];
  statusLoading: boolean;
  loadingConns: boolean;
  loadStatus: () => Promise<void>;
  loadConnections: () => Promise<void>;
  saveKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
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
      const res = await apiFetch("/api/composio/connections");
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
      const res = await apiFetch("/api/composio/status");
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

  const saveKey = useCallback(async (key: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await apiPost("/api/composio/setup", { key });
      const data = await res.json();
      if (res.ok && data.saved) {
        await loadStatus();
        return { ok: true };
      }
      return { ok: false, error: data.error ?? "Setup failed" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [loadStatus]);

  const connectToolkit = useCallback(async (toolkit: string): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> => {
    try {
      const res = await apiPost("/api/composio/connect", { toolkit });
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
      await apiPost("/api/composio/wait", { toolkit });
    } catch { /* best effort */ }
    await loadConnections();
  }, [loadConnections]);

  return { keyStatus, connections, statusLoading, loadingConns, loadStatus, loadConnections, saveKey, connectToolkit, waitForToolkit };
}
