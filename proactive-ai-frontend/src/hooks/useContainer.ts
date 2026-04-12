import { useState, useEffect, useCallback, useRef } from "react";
import { ensureContainer, fetchContainerStatus, probeGatewayHealth, destroyContainer } from "@/lib/api";

export type ContainerState =
  | "none"
  | "creating"
  | "running"
  | "stopped"
  | "suspended"
  | "error"
  | "missing";

interface ContainerInfo {
  status: ContainerState;
  loading: boolean;
  error: string | null;
}

/**
 * Manages the lifecycle of the user's container.
 *
 * Container creation is NOT automatic — the user must call `ensure()` manually.
 * The user can call `cancel()` to stop/destroy a creating container.
 */
export function useContainer(authenticated: boolean) {
  const [info, setInfo] = useState<ContainerInfo>({
    status: "none",
    loading: false,
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

  /** Poll gateway health until it responds OK. */
  const waitForGateway = useCallback(() => {
    setInfo({ status: "creating", loading: true, error: null });
    stopPolling();

    async function probe() {
      const ok = await probeGatewayHealth();
      if (!mountedRef.current) return;
      if (ok) {
        stopPolling();
        setInfo({ status: "running", loading: false, error: null });
      }
    }

    probe();
    pollRef.current = setInterval(probe, 3000);
  }, [stopPolling]);

  /** Poll container status until it reaches a terminal state. */
  const pollStatus = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const result = await fetchContainerStatus();
        if (!mountedRef.current) return;
        const status = result.status as ContainerState;

        if (status === "running") {
          waitForGateway();
        } else if (status === "error" || status === "none") {
          stopPolling();
          setInfo({ status, loading: false, error: null });
        }
      } catch {
        // Silently ignore poll errors
      }
    }, 3000);
  }, [stopPolling, waitForGateway]);

  /** Manually trigger container creation/ensure. */
  const ensure = useCallback(async () => {
    setInfo({ status: "creating", loading: true, error: null });
    try {
      const result = await ensureContainer();
      if (!mountedRef.current) return null;
      const status = result.status as ContainerState;

      if (status === "running") {
        waitForGateway();
      } else {
        setInfo({ status, loading: true, error: null });
        pollStatus();
      }

      return result;
    } catch (err) {
      if (!mountedRef.current) return null;
      setInfo({
        status: "error",
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      return null;
    }
  }, [waitForGateway, pollStatus]);

  /** Cancel container creation — stop polling and destroy the container. */
  const cancel = useCallback(async () => {
    stopPolling();
    setInfo({ status: "none", loading: true, error: null });
    try {
      await destroyContainer();
    } catch {
      // Ignore destroy errors
    }
    if (mountedRef.current) {
      setInfo({ status: "none", loading: false, error: null });
    }
  }, [stopPolling]);

  /** On auth, check existing container status (but don't create). */
  useEffect(() => {
    if (!authenticated) return;

    let cancelled = false;

    async function checkExisting() {
      try {
        const result = await fetchContainerStatus();
        if (cancelled) return;
        const status = result.status as ContainerState;
        if (status === "running") {
          waitForGateway();
        } else {
          // Show whatever state we find — don't auto-launch
          setInfo({ status, loading: false, error: null });
        }
      } catch {
        if (!cancelled) {
          setInfo({ status: "none", loading: false, error: null });
        }
      }
    }

    checkExisting();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [authenticated, waitForGateway, stopPolling]);

  return { ...info, ensure, cancel };
}
