import { proxyFetch } from "../transport/http";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentRunKind =
  | "auto.dreaming"
  | "connector.init"
  | "connector.evolve"
  | "generator.manual"
  | "generator.auto"
  | "user.prompt"
  | string;

export interface ActiveAgentRun {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  trigger: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  progress: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export const AGENT_RUN_TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function hasInflightAgentRuns(runs: ActiveAgentRun[]): boolean {
  return runs.some((r) => !AGENT_RUN_TERMINAL_STATUSES.has(r.status));
}

/** Surface in-flight agent runs to the UI (`GET /agent-runs/active`). */
export async function fetchActiveAgentRuns(
  signal?: AbortSignal,
): Promise<ActiveAgentRun[]> {
  const res = await proxyFetch("/agent-runs/active", { signal });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 120)}`);
  }
  const data = (await res.json()) as { ok?: boolean; runs?: ActiveAgentRun[] };
  return Array.isArray(data.runs) ? data.runs : [];
}
