/**
 * Polls a background_tasks row until it reaches a terminal status.
 *
 * Used by the Data Connections page to surface connector.init progress
 * after /composio/wait returns an initTaskId. The hook is read-only:
 * it never mutates the task. The pin tasks CLI (or a future admin UI)
 * is the write side.
 *
 * Design choices:
 * - Polling interval is fixed at 5s (web) / 10s (native via Capacitor).
 *   No exponential backoff — connector init is short-lived (seconds to
 *   a couple of minutes) and the user is staring at the chip waiting
 *   for it to flip.
 * - Polling stops the moment status is terminal so we don't keep beating
 *   on the proxy after success/failure.
 * - When taskId is null, the hook is fully idle (no fetches).
 */
import { useEffect, useRef, useState } from "react";
import { proxyFetch } from "@/lib/api";
import { isNative } from "@/lib/platform";

type TerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "skipped";
type RunningStatus = "queued" | "running";
export type TaskStatus = TerminalStatus | RunningStatus;

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "succeeded", "failed", "timed_out", "cancelled", "lost", "skipped",
]);

export interface InitTaskRow {
  id: string;
  type: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface UseInitTaskState {
  task: InitTaskRow | null;
  loading: boolean;
  error: string | null;
  /** True once the task hits a terminal status (success or failure family). */
  terminal: boolean;
}

const POLL_INTERVAL_MS = isNative ? 10_000 : 5_000;
const FRESH_WINDOW_MS = 60 * 60 * 1000; // 1h

/**
 * True when a task is worth surfacing in the UI:
 *   - non-terminal (queued / running) → always
 *   - terminal → only if it completed within FRESH_WINDOW_MS
 *
 * Connector init task ids are deterministic (`init.<toolkit>.<cid>`), so a
 * row hangs around forever once written. Without this filter, opening the
 * page next week would resurrect a "Done" chip from the last reconnect.
 */
export function isInitTaskFresh(task: InitTaskRow | null): boolean {
  if (!task) return false;
  if (!TERMINAL.has(task.status)) return true;
  if (!task.completed_at) return false;
  return Date.now() - Date.parse(task.completed_at) < FRESH_WINDOW_MS;
}

/**
 * Read-poll a background_tasks row. Pass null to disable polling entirely.
 * Returns the latest known task state plus loading/error/terminal flags.
 *
 * `restartToken` lets the caller force polling to resume after a terminal
 * status (we stop polling once a task is done, so re-enqueueing the same
 * task id needs an explicit kick — e.g. user clicks Reconnect twice).
 */
export function useInitTask(
  taskId: string | null,
  restartToken: number = 0,
): UseInitTaskState {
  const [task, setTask] = useState<InitTaskRow | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Track the *current* task id we're polling for. If the caller swaps it
  // mid-flight we want the in-flight fetch to be ignored.
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = taskId;
    if (!taskId) {
      setTask(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled || activeIdRef.current !== taskId) return;
      setLoading(true);
      try {
        const res = await proxyFetch(`/tasks/${encodeURIComponent(taskId)}`);
        if (cancelled || activeIdRef.current !== taskId) return;
        if (res.status === 404) {
          // Task disappeared (probably evicted / wrong id) — surface as
          // an error and stop polling. Caller can flush the chip.
          setError("Task not found");
          setTask(null);
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { task?: InitTaskRow };
        if (!body.task) throw new Error("Malformed response");
        setTask(body.task);
        setError(null);
        setLoading(false);
        if (TERMINAL.has(body.task.status)) return; // stop polling
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled || activeIdRef.current !== taskId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        // Network blip — keep polling. If the proxy is genuinely down,
        // the chip will show "Error" but we'll recover automatically.
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, restartToken]);

  return {
    task,
    loading,
    error,
    terminal: task ? TERMINAL.has(task.status) : false,
  };
}
