/**
 * Single source of truth for "is the backend currently generating cards?"
 *
 * Polls /runs/active every POLL_INTERVAL_MS and exposes a boolean. Powers
 * the small indicator in the app shell. Pauses polling when the tab is
 * hidden so we don't spend a request every 5s on every backgrounded
 * window.
 *
 * Why polling and not WebSocket: the indicator needs ~5s precision and the
 * user already has WebSocket connections to the OpenClaw control UI for
 * other purposes — adding generation-status to that channel would conflate
 * unrelated lifecycles. A single GET every 5s is cheap and stateless.
 */

import { useEffect, useRef, useState } from "react";
import { proxyFetch } from "@/lib/api";

const POLL_INTERVAL_MS = 5_000;

export type GenerationActiveStatus = "running" | "reconciling";

export interface ActiveGenerationRun {
  id: string;
  status: GenerationActiveStatus;
  trigger: string | null;
  startedAt: string | null;
}

export interface GenerationStatusState {
  loading: boolean;
  isGenerating: boolean;
  run: ActiveGenerationRun | null;
}

const INITIAL: GenerationStatusState = {
  loading: true,
  isGenerating: false,
  run: null,
};

function isActiveStatus(value: unknown): value is GenerationActiveStatus {
  return value === "running" || value === "reconciling";
}

function parseRun(payload: unknown): ActiveGenerationRun | null {
  if (!payload || typeof payload !== "object") return null;
  const r = payload as Record<string, unknown>;
  if (typeof r.id !== "string" || !isActiveStatus(r.status)) return null;
  return {
    id: r.id,
    status: r.status,
    trigger: typeof r.trigger === "string" ? r.trigger : null,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : null,
  };
}

export function useGenerationStatus(): GenerationStatusState & {
  /** Optimistically mark generating=true (e.g. right after dispatching /generate). */
  markStarted: () => void;
  /** Force a refresh now instead of waiting for the next tick. */
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<GenerationStatusState>(INITIAL);
  const optimisticUntilRef = useRef<number>(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await proxyFetch("/runs/active", { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok) {
          // Don't flip to !isGenerating on transient errors — keep last known.
          setState((prev) => ({ ...prev, loading: false }));
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const run = parseRun(data?.run);
        const optimisticUntil = optimisticUntilRef.current;
        const stillOptimistic = optimisticUntil > 0 && Date.now() < optimisticUntil;
        if (run) {
          // Real active run takes priority over optimistic flag.
          optimisticUntilRef.current = 0;
          setState({ loading: false, isGenerating: true, run });
        } else if (stillOptimistic) {
          setState({ loading: false, isGenerating: true, run: null });
        } else {
          setState({ loading: false, isGenerating: false, run: null });
        }
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      } finally {
        inFlightRef.current = false;
      }
    }

    void load();
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, POLL_INTERVAL_MS);

    function onVisibility() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const markStarted = () => {
    // Optimistic window: keep the indicator lit for up to one full polling
    // cycle plus a buffer in case the backend hasn't surfaced the new
    // pipeline_run yet. The server always wins after that.
    optimisticUntilRef.current = Date.now() + POLL_INTERVAL_MS + 2_000;
    setState((prev) => ({ ...prev, isGenerating: true }));
  };

  const refresh = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await proxyFetch("/runs/active");
      if (!res.ok) return;
      const data = await res.json();
      const run = parseRun(data?.run);
      if (run) {
        setState({ loading: false, isGenerating: true, run });
      } else {
        setState({ loading: false, isGenerating: false, run: null });
      }
    } catch {
      /* ignore */
    } finally {
      inFlightRef.current = false;
    }
  };

  return { ...state, markStarted, refresh };
}
