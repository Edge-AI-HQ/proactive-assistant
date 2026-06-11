import { readErrorMessage } from "../transport/errors";
import { proxyFetch, proxyPost } from "../transport/http";

// ── Scheduled generators (user-created recurring card generation) ──
// Backs the Settings > Preferences management list and Main Chat's
// create-via-confirmation flow. Server keys are camelCase (web `_dump`);
// parsedIntent / confirmedBrief are opaque blobs echoed back verbatim on
// create — the backend normalizes their keys, so don't reshape them here.

export interface ScheduledGeneratorParsedIntent {
  frequency?: string;
  localTime?: string;
  timezone?: string;
  topic?: string;
  cardCount?: number;
  [key: string]: unknown;
}

export interface ScheduledGeneratorConfirmedBrief {
  title?: string;
  topic?: string;
  instruction?: string;
  [key: string]: unknown;
}

export interface ScheduledGeneratorTask {
  id: string;
  kind: string;
  status: "active" | "paused" | "archived";
  title: string;
  frequency: string | null;
  localTime: string | null;
  timezone: string;
  cronExpr: string | null;
  /** "once" | "schedule"; optional so tasks from older backends still parse. */
  triggerKind?: string | null;
  intervalSeconds?: number | null;
  scheduleLabel?: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  payload: Record<string, unknown>;
}

export interface ScheduledGeneratorSchedule {
  type: "once" | "interval" | "cron";
  inMinutes?: number;
  atLocal?: string;
  everySeconds?: number;
  frequency?: "daily" | "weekly";
  localTime?: string;
  /** ISO weekday numbers, 1=Monday … 7=Sunday */
  daysOfWeek?: number[];
}

export interface ScheduledGeneratorReminder {
  title: string;
  message: string;
}

/** Preview's similarTasks items are a summary subset (backend _task_summary),
 *  NOT full tasks — create's 409 branch is the one that returns full tasks. */
export interface ScheduledGeneratorTaskSummary {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  frequency: string | null;
  localTime: string | null;
  timezone: string;
  scheduleLabel: string | null;
}

export interface ScheduledGeneratorPreview {
  previewId: string;
  parsedIntent: ScheduledGeneratorParsedIntent;
  confirmedBrief: ScheduledGeneratorConfirmedBrief;
  semanticSignature: string;
  similarTasks: ScheduledGeneratorTaskSummary[];
  conversationId: string | null;
  scheduleLabel: string;
  mode: string;
  reminder: ScheduledGeneratorReminder | null;
}

export interface ScheduledGeneratorPreviewRequest {
  originalRequest: string;
  timezone: string;
  schedule: ScheduledGeneratorSchedule;
  mode?: "reminder" | "generate";
  topic?: string | null;
  reminder?: ScheduledGeneratorReminder | null;
  conversationId?: string | null;
}

export interface ScheduledGeneratorCreateRequest {
  previewId: string;
  semanticSignature: string;
  originalRequest: string;
  timezone: string;
  schedule: ScheduledGeneratorSchedule;
  mode?: "reminder" | "generate";
  topic?: string | null;
  reminder?: ScheduledGeneratorReminder | null;
  confirmedBrief?: ScheduledGeneratorConfirmedBrief | null;
  duplicateAck?: boolean;
  similarTaskIdsSeen?: string[];
}

/** create resolves to the task, or — on a 409 — to the similar tasks the
 *  backend wants one more confirmation against (NOT thrown, it's a normal
 *  branch the caller surfaces to the user). */
export type ScheduledGeneratorCreateResult =
  | { ok: true; task: ScheduledGeneratorTask }
  | { ok: false; requiresConfirmation: true; similarTasks: ScheduledGeneratorTask[] };

export async function scheduledGeneratorPreview(
  req: ScheduledGeneratorPreviewRequest,
): Promise<ScheduledGeneratorPreview> {
  const res = await proxyPost("/scheduled-generators/preview", req);
  if (!res.ok)
    throw new Error(`scheduled generator preview failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function scheduledGeneratorCreate(
  req: ScheduledGeneratorCreateRequest,
): Promise<ScheduledGeneratorCreateResult> {
  const res = await proxyPost("/scheduled-generators", req);
  if (res.status === 409) {
    const body = await res.json();
    return { ok: false, requiresConfirmation: true, similarTasks: body.similarTasks ?? [] };
  }
  if (!res.ok)
    throw new Error(`scheduled generator create failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return { ok: true, task: body.task };
}

export async function listScheduledGenerators(
  includeArchived = false,
): Promise<ScheduledGeneratorTask[]> {
  const query = includeArchived ? "?includeArchived=true" : "";
  const res = await proxyFetch(`/scheduled-generators${query}`);
  if (!res.ok)
    throw new Error(`list scheduled generators failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.items ?? [];
}

export async function pauseScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyPost(`/scheduled-generators/${encodeURIComponent(taskId)}/pause`, {});
  if (!res.ok)
    throw new Error(`pause scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}

export async function resumeScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyPost(`/scheduled-generators/${encodeURIComponent(taskId)}/resume`, {});
  if (!res.ok)
    throw new Error(`resume scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}

export async function deleteScheduledGenerator(taskId: string): Promise<ScheduledGeneratorTask> {
  const res = await proxyFetch(`/scheduled-generators/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
  if (!res.ok)
    throw new Error(`delete scheduled generator failed: ${await readErrorMessage(res)}`);
  const body = await res.json();
  return body.task;
}
