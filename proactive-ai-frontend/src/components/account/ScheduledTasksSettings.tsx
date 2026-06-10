import { useEffect, useState } from "react";

import {
  deleteScheduledGenerator,
  listScheduledGenerators,
  pauseScheduledGenerator,
  resumeScheduledGenerator,
  type ScheduledGeneratorTask,
} from "@/lib/api";

// Server-rendered label ("每 5 分钟" / "一次 · 06-10 15:00") wins; legacy tasks
// without scheduleLabel fall back to joining the cron fields, dropping empty
// parts so a missing field doesn't render stray separators.
function formatSchedule(task: ScheduledGeneratorTask): string {
  if (task.scheduleLabel) return task.scheduleLabel;
  return [task.frequency, task.localTime, task.timezone].filter(Boolean).join(" · ");
}

export default function ScheduledTasksSettings() {
  const [tasks, setTasks] = useState<ScheduledGeneratorTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const items = await listScheduledGenerators();
        if (mounted) setTasks(items);
      } catch {
        if (mounted) setError("Failed to load scheduled tasks");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleToggle = async (task: ScheduledGeneratorTask) => {
    const next = task.status === "active" ? "paused" : "active";
    setPendingId(task.id);
    setError(null);
    try {
      const updated =
        next === "paused"
          ? await pauseScheduledGenerator(task.id)
          : await resumeScheduledGenerator(task.id);
      setTasks((current) => current.map((t) => (t.id === task.id ? updated : t)));
    } catch {
      setError(`Failed to ${next === "paused" ? "pause" : "resume"} task`);
    } finally {
      setPendingId(null);
    }
  };

  const handleDelete = async (task: ScheduledGeneratorTask) => {
    setPendingId(task.id);
    setError(null);
    try {
      await deleteScheduledGenerator(task.id);
      setTasks((current) => current.filter((t) => t.id !== task.id));
    } catch {
      setError("Failed to delete task");
    } finally {
      setPendingId(null);
    }
  };

  if (loading) {
    return <p className="text-[11px] text-foreground/45">Loading scheduled tasks…</p>;
  }

  if (tasks.length === 0) {
    return (
      <p className="text-[11px] text-foreground/45">
        No scheduled tasks yet. Create one from chat — for example, ask for a daily news digest.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => {
        const active = task.status === "active";
        const busy = pendingId === task.id;
        return (
          <div key={task.id} className="rounded-2xl bg-foreground/[0.04] px-3 py-3 space-y-2">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">
                  {task.title || "Scheduled task"}
                </div>
                <div className="text-[11px] text-foreground/45 mt-0.5">{formatSchedule(task)}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={active}
                aria-label={`${task.title || "Scheduled task"} active`}
                disabled={busy}
                onClick={() => void handleToggle(task)}
                className={`
                  relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full
                  border border-foreground/10 transition-colors duration-200 ease-in-out
                  disabled:cursor-not-allowed disabled:opacity-40
                  ${active ? "bg-primary" : "bg-foreground/10"}
                `}
              >
                <span
                  className={`
                    pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ease-in-out
                    ${active ? "translate-x-[22px]" : "translate-x-[3px]"}
                  `}
                />
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  active ? "text-emerald-600 bg-emerald-500/10" : "text-amber-700 bg-amber-500/10"
                }`}
              >
                {active ? "active" : "paused"}
              </span>
              <button
                type="button"
                onClick={() => void handleDelete(task)}
                disabled={busy}
                className="text-[11px] text-red-500/80 hover:text-red-500 transition-colors disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
      {error && <p className="text-[11px] text-red-500/80">{error}</p>}
    </div>
  );
}
