import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchContainerStatus,
  probeGatewayHealth,
  destroyContainer,
  resetContainer,
} from "@/lib/api";

/**
 * Public state machine — kept intentionally small.
 *
 * - `unknown`     — auth just resolved, initial status request still in flight
 * - `connecting`  — backend reports creating/running but gateway hasn't proven
 *                   itself healthy yet. Bounded by a probe budget (see below).
 * - `ready`       — gateway responded OK; AppShell can render.
 * - `unhealthy`   — anything else (no container, error state, probe budget
 *                   exhausted, hard failure). User decides next step.
 *
 * Login is never gated on container readiness. App.tsx renders Dashboard while
 * status is `unknown`/`connecting`/`unhealthy` and only swaps in AppShell when
 * status flips to `ready`.
 */
export type ContainerState = "unknown" | "connecting" | "ready" | "unhealthy";

interface ContainerInfo {
  status: ContainerState;
  /** 1-based attempt counter for the current connecting phase. */
  connectAttempt: number;
  connectMaxAttempts: number;
  /**
   * True when we have no record of a successfully provisioned container in
   * this session — drives the "Start your assistant" vs "Reconnect/Recreate"
   * choice in the unhealthy UI.
   */
  firstTime: boolean;
  error: string | null;
}

const PROBE_INTERVAL_MS = 3000;
// Cold start of an OpenClaw container on shared-cpu-1x is ~30-60s. Probe
// every 3s up to 60s so a healthy-but-slow boot still resolves on its own.
const CONNECT_BUDGET_MS = 60_000;
const MAX_PROBE_ATTEMPTS = Math.ceil(CONNECT_BUDGET_MS / PROBE_INTERVAL_MS);

export function useContainer(authenticated: boolean) {
  const [info, setInfo] = useState<ContainerInfo>({
    status: "unknown",
    connectAttempt: 0,
    connectMaxAttempts: MAX_PROBE_ATTEMPTS,
    firstTime: true,
    error: null,
  });

  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
  }, []);

  /**
   * Run a bounded gateway probe loop. On success → `ready`; on terminal
   * backend state or budget exhaustion → `unhealthy`. Used for both the
   * initial post-login check and for explicit `reconnect()` / `recreate()`.
   */
  const startConnecting = useCallback(() => {
    stopPolling();
    setInfo((prev) => ({
      ...prev,
      status: "connecting",
      connectAttempt: 0,
      connectMaxAttempts: MAX_PROBE_ATTEMPTS,
      error: null,
    }));

    let attempt = 0;

    const tick = async () => {
      attempt += 1;
      if (!mountedRef.current) return;
      setInfo((prev) => ({ ...prev, connectAttempt: attempt }));

      const probe = await probeGatewayHealth();
      if (!mountedRef.current) return;

      if (probe.ok) {
        stopPolling();
        setInfo((prev) => ({
          ...prev,
          status: "ready",
          firstTime: false,
          error: null,
        }));
        return;
      }

      // Gateway explicitly says "no container" — short-circuit.
      if (probe.code === "NO_CONTAINER") {
        stopPolling();
        setInfo((prev) => ({
          ...prev,
          status: "unhealthy",
          firstTime: true,
          error: null,
        }));
        return;
      }

      // Periodically check backend state to bail out early on hard failures.
      if (attempt % 2 === 0) {
        try {
          const result = await fetchContainerStatus();
          if (!mountedRef.current) return;
          if (result.status === "error") {
            stopPolling();
            setInfo((prev) => ({
              ...prev,
              status: "unhealthy",
              error: probe.message ?? "Container failed to start.",
            }));
            return;
          }
          if (result.status === "missing" || result.status === "none") {
            stopPolling();
            setInfo((prev) => ({
              ...prev,
              status: "unhealthy",
              firstTime: true,
              error: null,
            }));
            return;
          }
        } catch {
          // ignore — keep probing until budget is exhausted
        }
      }

      if (attempt >= MAX_PROBE_ATTEMPTS) {
        stopPolling();
        setInfo((prev) => ({
          ...prev,
          status: "unhealthy",
          error: probe.message ?? "Connection timed out.",
        }));
      }
    };

    void tick();
    pollRef.current = setInterval(() => { void tick(); }, PROBE_INTERVAL_MS);
  }, [stopPolling]);

  /**
   * Cancel an in-flight connection attempt: stop polling, destroy the
   * container, drop into `unhealthy` with `firstTime=true` so the UI shows
   * "Start your assistant" rather than "Reconnect".
   */
  const cancel = useCallback(async () => {
    stopPolling();
    setInfo((prev) => ({
      ...prev,
      status: "unhealthy",
      firstTime: true,
      error: null,
    }));
    try {
      await destroyContainer();
    } catch {
      // best-effort; user's next action will reconcile
    }
  }, [stopPolling]);

  /** Re-run the probe budget without touching the container. */
  const reconnect = useCallback(() => {
    startConnecting();
  }, [startConnecting]);

  /**
   * Destroy + ensure via /reset (idempotent: destroy is a no-op when nothing
   * exists). Single entry point for both first-time creation and recovery.
   */
  const recreate = useCallback(async () => {
    stopPolling();
    setInfo((prev) => ({
      ...prev,
      status: "connecting",
      connectAttempt: 0,
      connectMaxAttempts: MAX_PROBE_ATTEMPTS,
      error: null,
    }));
    try {
      await resetContainer();
      if (mountedRef.current) startConnecting();
    } catch (err) {
      if (!mountedRef.current) return;
      setInfo((prev) => ({
        ...prev,
        status: "unhealthy",
        error: err instanceof Error ? err.message : "Failed to create container.",
      }));
    }
  }, [startConnecting, stopPolling]);

  // Initial check on auth: peek at backend status, then either probe gateway
  // (for running/creating containers) or drop into unhealthy.
  useEffect(() => {
    if (!authenticated) {
      stopPolling();
      setInfo({
        status: "unknown",
        connectAttempt: 0,
        connectMaxAttempts: MAX_PROBE_ATTEMPTS,
        firstTime: true,
        error: null,
      });
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const result = await fetchContainerStatus();
        if (cancelled) return;

        const exists =
          result.status === "running" ||
          result.status === "creating" ||
          result.status === "stopped" ||
          result.status === "suspended" ||
          result.status === "error";

        if (result.status === "running" || result.status === "creating") {
          setInfo((prev) => ({ ...prev, firstTime: false }));
          startConnecting();
          return;
        }

        setInfo((prev) => ({
          ...prev,
          status: "unhealthy",
          firstTime: !exists,
          error: result.status === "error" ? "Container is in an error state." : null,
        }));
      } catch (err) {
        if (cancelled) return;
        setInfo((prev) => ({
          ...prev,
          status: "unhealthy",
          firstTime: true,
          error: err instanceof Error ? err.message : null,
        }));
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [authenticated, startConnecting, stopPolling]);

  return {
    ...info,
    cancel,
    reconnect,
    recreate,
  };
}
