import { useState, useEffect, useCallback, useRef } from "react";
import {
  ensureContainer,
  fetchContainerStatus,
  probeGatewayHealth,
  destroyContainer,
} from "@/lib/api";

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
  initialChecking: boolean;
  error: string | null;
}

const GATEWAY_FAILURE_THRESHOLD = 3;
const CONTAINER_REMOVED_ERROR = "Container was removed. Launch again.";


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
    initialChecking: true,
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

  const setTerminalState = useCallback(
    (status: Exclude<ContainerState, "creating" | "running">, error: string | null = null) => {
      stopPolling();
      setInfo({
        status,
        loading: false,
        initialChecking: false,
        error,
      });
    },
    [stopPolling],
  );

  const syncStatusAfterGatewayFailure = useCallback(
    async (fallbackError: string | null = null): Promise<ContainerState | null> => {
      try {
        const result = await fetchContainerStatus();
        if (!mountedRef.current) return null;

        const status = result.status as ContainerState;
        if (status === "running") {
          return status;
        }

        if (status === "creating") {
          setInfo({ status, loading: true, initialChecking: false, error: null });
          return status;
        }

        setTerminalState(status, fallbackError);
        return status;
      } catch (err) {
        if (!mountedRef.current) return null;
        setTerminalState(
          "error",
          err instanceof Error ? err.message : "Unknown error",
        );
        return "error";
      }
    },
    [setTerminalState],
  );

  /** Poll gateway health until it responds OK. */
  const waitForGateway = useCallback(() => {
    setInfo((prev) => ({ ...prev, status: "creating", loading: true, error: null }));
    stopPolling();
    let consecutiveFailures = 0;

    async function probe() {
      const result = await probeGatewayHealth();
      if (!mountedRef.current) return;
      if (result.ok) {
        stopPolling();
        setInfo({ status: "running", loading: false, initialChecking: false, error: null });
        return;
      }

      if (result.code === "NO_CONTAINER") {
        await syncStatusAfterGatewayFailure(
          result.message ? `${result.message}. Launch again.` : CONTAINER_REMOVED_ERROR,
        );
        return;
      }

      if (
        result.code === "CONTAINER_NOT_RUNNING" ||
        result.code === "RESUMING"
      ) {
        const status = await syncStatusAfterGatewayFailure();
        if (status === "running" || status === "creating") {
          consecutiveFailures = 0;
        }
        return;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures < GATEWAY_FAILURE_THRESHOLD) {
        return;
      }

      const status = await syncStatusAfterGatewayFailure();
      if (status === "running" || status === "creating") {
        consecutiveFailures = 0;
      }
    }

    void probe();
    pollRef.current = setInterval(() => {
      void probe();
    }, 3000);
  }, [stopPolling, syncStatusAfterGatewayFailure]);

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
        } else if (
          status === "error" ||
          status === "none" ||
          status === "stopped" ||
          status === "suspended" ||
          status === "missing"
        ) {
          setTerminalState(status);
        } else if (status === "creating") {
          setInfo({ status, loading: true, initialChecking: false, error: null });
        }
      } catch {
        // Silently ignore poll errors
      }
    }, 3000);
  }, [setTerminalState, stopPolling, waitForGateway]);

  /** Manually trigger container creation/ensure. */
  const ensure = useCallback(async () => {
    setInfo({ status: "creating", loading: true, initialChecking: false, error: null });
    try {
      const result = await ensureContainer();
      if (!mountedRef.current) return null;
      const status = result.status as ContainerState;

      if (status === "running") {
        waitForGateway();
      } else {
        setInfo({ status, loading: true, initialChecking: false, error: null });
        pollStatus();
      }

      return result;
    } catch (err) {
      if (!mountedRef.current) return null;
      setInfo({
        status: "error",
        loading: false,
        initialChecking: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
      return null;
    }
  }, [waitForGateway, pollStatus]);

  /** Cancel container creation — stop polling and destroy the container. */
  const cancel = useCallback(async () => {
    stopPolling();
    setInfo({ status: "none", loading: true, initialChecking: false, error: null });
    try {
      await destroyContainer();
    } catch {
      // Ignore destroy errors
    }
    if (mountedRef.current) {
      setInfo({ status: "none", loading: false, initialChecking: false, error: null });
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
          setInfo({
            status,
            loading: status === "creating",
            initialChecking: false,
            error: null,
          });
        }
      } catch {
        if (!cancelled) {
          setInfo({ status: "none", loading: false, initialChecking: false, error: null });
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
