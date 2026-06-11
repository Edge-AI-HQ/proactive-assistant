import { readErrorMessage } from "../transport/errors";
import { proxyFetch, proxyPost } from "../transport/http";

// ── v3 Memory (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/memory.ts` (v3 `MemoryRowV3`).
// DELETE is intentionally unavailable: use archive or supersede.

export type MemoryStatus = "active" | "archived" | "superseded";

export interface Memory {
  id: string;
  text: string;
  source: string;
  source_run_id: string | null;
  subject: string | null;
  quality: number;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  occurred_at: string | null;
  created_at: string;
  tags: string[];
  related_memory_ids: string[];
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
}

export interface MemoryListFilter {
  status?: MemoryStatus;
  source?: string;
  subject?: string;
  subjectPrefix?: string;
  minQuality?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created_at" | "quality" | "last_referenced_at";
  orderDirection?: "asc" | "desc";
}

export interface MemoryCreateInput {
  text: string;
  source: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
  occurredAt?: string | null;
  sourceRunId?: string | null;
}

export interface MemoryPatch {
  text?: string;
  subject?: string | null;
  quality?: number;
  confidence?: number;
  tags?: string[];
}

export async function fetchMemories(
  filter?: MemoryListFilter,
  signal?: AbortSignal,
): Promise<{ ok: boolean; memories: Memory[]; total: number }> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.subject) qs.set("subject", filter.subject);
  if (filter?.subjectPrefix) qs.set("subjectPrefix", filter.subjectPrefix);
  if (typeof filter?.minQuality === "number") qs.set("minQuality", String(filter.minQuality));
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.orderBy) qs.set("orderBy", filter.orderBy);
  if (filter?.orderDirection) qs.set("orderDirection", filter.orderDirection);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/memory${suffix}`, { signal });
  if (!res.ok) throw new Error(`/memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchMemory(id: string, signal?: AbortSignal): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/memory/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createMemory(input: MemoryCreateInput): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyPost("/memory", input);
  if (!res.ok) throw new Error(`create memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateMemory(id: string, patch: MemoryPatch): Promise<{ ok: boolean; memory: Memory }> {
  const res = await proxyFetch(`/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update memory failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveMemory(id: string): Promise<void> {
  const res = await proxyPost(`/memory/${encodeURIComponent(id)}/archive`, {});
  if (!res.ok) throw new Error(`archive memory failed: ${await readErrorMessage(res)}`);
}

export async function supersedeMemory(oldId: string, newId: string): Promise<void> {
  const res = await proxyPost("/memory/supersede", { oldId, newId });
  if (!res.ok) throw new Error(`supersede memory failed: ${await readErrorMessage(res)}`);
}
