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
  connectToolkit: (
    toolkit: string,
  ) => Promise<{ ok: boolean; redirectUrl?: string; error?: string }>;
  disconnectAccount: (
    connectedAccountId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  waitForToolkit: (toolkit: string) => Promise<{ connected: boolean }>;
  cancelWait: () => void;
  isToolkitConnected: (toolkit: string) => boolean;
}

export function useComposio(): ComposioState {
  const [keyStatus, setKeyStatus] = useState<ComposioStatus | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [loadingConns, setLoadingConns] = useState(false);

  /** After OAuth succeeds: pull bounded history via gateway subagent + merge profile (best-effort, non-blocking). */
  const fireProfileIngest = useCallback((toolkit: string) => {
    void (async () => {
      try {
        const res = await apiRpcPost("/profile/connector-ingest", {
          toolkit,
          maxRecords: 50,
          apply: true,
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          console.warn("[profile-ingest] failed", res.status, t.slice(0, 500));
          return;
        }
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const history = body.history as
          | { storedRawDataIds?: string[] }
          | null
          | undefined;
        const hostPersist = body.hostPersist as
          | { rawDataIds?: string[]; skipped?: string; appliedFacts?: string[] }
          | null
          | undefined;
        console.info("[profile-ingest] ok", {
          toolkit,
          cliDriven: body.cliDriven === true,
          hasPatch: body.patch != null,
          historyRows: history?.storedRawDataIds?.length ?? 0,
          hostRawRows: hostPersist?.rawDataIds?.length ?? 0,
          hostSkipped: hostPersist?.skipped,
          profileApplied: body.applied != null,
          hint: typeof body.hint === "string" ? body.hint : undefined,
        });
      } catch (e) {
        console.warn("[profile-ingest]", e);
      }
    })();
  }, []);

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

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const saveApiKey = useCallback(
    async (key: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await apiRpcPost("/composio/setup", { key });
        const data = await res.json();
        if (!res.ok) {
          return {
            ok: false,
            error: data.error?.message ?? data.error ?? "Invalid key",
          };
        }
        // Reload status + connections after key saved
        await loadStatus();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [loadStatus],
  );

  const connectToolkit = useCallback(
    async (
      toolkit: string,
    ): Promise<{ ok: boolean; redirectUrl?: string; error?: string }> => {
      try {
        const res = await apiRpcPost("/composio/connect", { toolkit });
        const data = await res.json();
        if (data.status === "ACTIVE") {
          await loadConnections();
          fireProfileIngest(toolkit);
          return { ok: true };
        }
        if (data.redirectUrl) {
          return { ok: true, redirectUrl: data.redirectUrl };
        }
        return { ok: false, error: "No redirect URL returned" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [loadConnections, fireProfileIngest],
  );

  const disconnectAccount = useCallback(
    async (
      connectedAccountId: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await apiRpcPost("/composio/disconnect", {
          connectedAccountId,
        });
        if (!res.ok) {
          const data = await res.json();
          return {
            ok: false,
            error: data.error?.message ?? data.error ?? "Disconnect failed",
          };
        }
        await loadConnections();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [loadConnections],
  );

  const waitAbortRef = useRef<AbortController | null>(null);

  const waitForToolkit = useCallback(
    async (toolkit: string): Promise<{ connected: boolean }> => {
      waitAbortRef.current?.abort();
      const controller = new AbortController();
      waitAbortRef.current = controller;
      /** Server long-poll cap per request — stay under common proxy read timeouts (~60s). */
      const CHUNK_MS = 12_000;
      const OVERALL_DEADLINE = Date.now() + 120_000;
      const tk = toolkit.toLowerCase();

      const listShowsActive = (conns: Connection[]) =>
        conns.some(
          (c) => c.toolkit.toLowerCase() === tk && c.status === "ACTIVE",
        );

      try {
        while (Date.now() < OVERALL_DEADLINE) {
          if (controller.signal.aborted) return { connected: false };

          const res = await apiRpcPost(
            "/composio/wait",
            { toolkit, maxWaitMs: CHUNK_MS },
            controller.signal,
          );

          let data: Record<string, unknown> = {};
          try {
            data = (await res.json()) as Record<string, unknown>;
          } catch {
            /* ignore malformed body */
          }

          const conns = await loadConnections();
          const status = String(data.status ?? "").toUpperCase();
          if (listShowsActive(conns) || (res.ok && status === "ACTIVE")) {
            fireProfileIngest(toolkit);
            return { connected: true };
          }

          if (!res.ok) {
            console.warn("[composio/wait] non-OK response", res.status, data);
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }

          await new Promise((r) => setTimeout(r, 400));
        }

        const tail = await loadConnections();
        if (listShowsActive(tail)) {
          fireProfileIngest(toolkit);
          return { connected: true };
        }
        return { connected: false };
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return { connected: false };
        }
        console.warn("[composio/wait]", err);
        const conns = await loadConnections();
        if (listShowsActive(conns)) {
          fireProfileIngest(toolkit);
          return { connected: true };
        }
        return { connected: false };
      } finally {
        if (waitAbortRef.current === controller) waitAbortRef.current = null;
      }
    },
    [loadConnections, fireProfileIngest],
  );

  const cancelWait = useCallback(() => {
    waitAbortRef.current?.abort();
    waitAbortRef.current = null;
  }, []);

  const isToolkitConnected = useCallback(
    (toolkit: string): boolean => {
      return connections.some(
        (c) =>
          c.toolkit.toLowerCase() === toolkit.toLowerCase() &&
          c.status === "ACTIVE",
      );
    },
    [connections],
  );

  return {
    keyStatus,
    connections,
    statusLoading,
    loadingConns,
    loadStatus,
    loadConnections,
    saveApiKey,
    connectToolkit,
    disconnectAccount,
    waitForToolkit,
    cancelWait,
    isToolkitConnected,
  };
}
