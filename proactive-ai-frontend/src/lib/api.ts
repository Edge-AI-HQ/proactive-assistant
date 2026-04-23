/**
 * API client for the proactive-ai cloud service.
 *
 * All calls go through the APIs reverse proxy:
 *   /api/proactive/*   → APIs endpoints (auth, container management)
 *   /api/proxy/*       → user's container (pipeline, chat, etc.)
 *
 * Auth: Supabase JWT is attached automatically via getAccessToken().
 */

import { supabase } from "./supabase";
import { API_BASE } from "./platform";

export interface Goal {
  id: string;
  user_id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRecord {
  id: string;
  user_id: string;
  display_name: string;
  locale: string;
  timezone: string;
  summary: string | null;
  facts: Record<string, unknown>;
  preferences: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileMemory {
  id: string;
  user_id: string;
  kind: string;
  text: string;
  tags: string[];
  created_at: string;
}

export interface ProfileSignal {
  id: string;
  user_id: string;
  kind: string;
  target_type: string;
  target_key: string;
  value: number | null;
  source: string | null;
  context: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
}

export interface ProfileInterest {
  id: string;
  user_id: string;
  kind: string;
  key: string;
  score: number;
  confidence: number;
  evidence_count: number;
  status: string;
  last_signal_at: string | null;
}

export interface ProfileSnapshot {
  profile: ProfileRecord | null;
  goals: Goal[];
  memories: ProfileMemory[];
  signals: ProfileSignal[];
  interests: ProfileInterest[];
}

async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status}`;

    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data?.error === "string" && data.error.trim()) {
        return `${res.status} ${data.error}`;
      }
    } catch {
      // Fall back to the raw response text when the body is not JSON.
    }

    return `${res.status} ${text}`;
  } catch {
    return `${res.status}`;
  }
}

/**
 * Refresh the Supabase session and return a fresh access token.
 * Returns null if refresh fails (user should be signed out).
 */
async function refreshAndGetToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return data.session.access_token;
}

export async function proactiveFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status !== 401) return res;

  const freshToken = await refreshAndGetToken();
  if (!freshToken) return res;

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...headers,
      Authorization: `Bearer ${freshToken}`,
    },
  });
}

// ── APIs endpoints (/api/proactive/*) ──

export async function fetchMe(): Promise<{
  user: { id: string; email: string; name: string | null; avatar_url: string | null };
  container: { status: string; created_at: string } | null;
}> {
  const res = await proactiveFetch("/api/proactive/auth/me");
  if (!res.ok) throw new Error(`/auth/me failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function heartbeat(): Promise<void> {
  await proactiveFetch("/api/proactive/user/heartbeat", {
    method: "POST",
  });
}

export async function ensureContainer(): Promise<{
  containerId: string;
  ready: boolean;
  status: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/ensure", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/ensure failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function resetContainer(): Promise<{ ok: boolean; containerId: string; ready: boolean }> {
  const res = await proactiveFetch("/api/proactive/container/reset", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/reset failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function destroyContainer(): Promise<{ ok: boolean }> {
  const res = await proactiveFetch("/api/proactive/container/destroy", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/container/destroy failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchContainerStatus(): Promise<{
  status: string;
  created_at?: string;
}> {
  const res = await proactiveFetch("/api/proactive/container/status");
  if (!res.ok) throw new Error(`/container/status failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Account deletion ──

export async function deleteAccount(): Promise<void> {
  const res = await proactiveFetch("/api/proactive/user/account", {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`/user/account delete failed: ${await readErrorMessage(res)}`);
}

// ── Model management ──

export interface ModelOption {
  id: string;
  ref: string;
}

export interface ModelsResponse {
  ok: boolean;
  current_model: string;
  default_model: string;
  available_models: ModelOption[];
}

export type GatewayProbeCode =
  | "NO_CONTAINER"
  | "PROXY_ERROR"
  | "RESUMING"
  | "CONTAINER_NOT_RUNNING";

export interface GatewayProbeResult {
  ok: boolean;
  httpStatus: number | null;
  code?: GatewayProbeCode;
  message?: string;
}

function toGatewayProbeCode(value: unknown): GatewayProbeCode | undefined {
  switch (value) {
    case "NO_CONTAINER":
    case "PROXY_ERROR":
    case "RESUMING":
    case "CONTAINER_NOT_RUNNING":
      return value;
    default:
      return undefined;
  }
}

export async function fetchModels(signal?: AbortSignal): Promise<ModelsResponse> {
  const res = await proactiveFetch("/api/proactive/models", { signal });
  if (!res.ok) throw new Error(`/models failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function changeModel(
  modelRef: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; model: string }> {
  const res = await proactiveFetch("/api/proactive/models/change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelRef }),
    signal,
  });
  if (!res.ok) throw new Error(`/models/change failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Gateway ticket ──

export async function getGatewayTicket(): Promise<{
  ticket: string;
  expiresIn: number;
  url: string;
}> {
  const res = await proactiveFetch("/api/proactive/gateway/ticket", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`/gateway/ticket failed: ${await readErrorMessage(res)}`);
  return res.json();
}

// ── Gateway readiness probe ──

export async function probeGatewayHealth(): Promise<GatewayProbeResult> {
  try {
    const res = await fetch(`${API_BASE}/api/proxy/health`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = await res.json();
      data =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      data = null;
    }

    const message =
      typeof data?.error === "string"
        ? data.error
        : typeof data?.message === "string"
          ? data.message
          : undefined;
    const code = toGatewayProbeCode(data?.code);

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        code,
        message: message || res.statusText || "Gateway health check failed",
      };
    }

    return {
      ok: typeof data?.ok === "boolean" ? data.ok : true,
      httpStatus: res.status,
      code,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      message: error instanceof Error ? error.message : "Gateway health check failed",
    };
  }
}

// ── Container proxy endpoints (/api/proxy/*) ──

/**
 * Fetch via the container proxy.  Automatically retries once on 401
 * after refreshing the Supabase session token.
 */
export async function proxyFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers });

  // Retry once with a refreshed token on 401
  if (res.status === 401) {
    const freshToken = await refreshAndGetToken();
    if (freshToken) {
      const retryHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${freshToken}`,
      };
      return fetch(`${API_BASE}/api/proxy${path}`, { ...init, headers: retryHeaders });
    }
  }

  return res;
}

export async function proxyPost(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  return proxyFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function fetchProfileSnapshot(
  signal?: AbortSignal
): Promise<ProfileSnapshot> {
  const res = await proxyFetch("/profile", { signal });
  if (!res.ok) throw new Error(`/profile failed: ${res.status}`);

  const data = await res.json();
  return {
    profile: data?.profile ?? null,
    goals: Array.isArray(data?.goals) ? data.goals : [],
    memories: Array.isArray(data?.memories) ? data.memories : [],
    signals: Array.isArray(data?.signals) ? data.signals : [],
    interests: Array.isArray(data?.interests) ? data.interests : [],
  };
}

/**
 * SSE stream from the container proxy.
 * Returns an async iterator of parsed JSON events.
 */
export async function* proxySSE<T = unknown>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const res = await proxyPost(path, body, signal);
  if (!res.ok) throw new Error(`Proxy SSE ${path} failed: ${res.status}`);
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as T;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Conversation Crystallize (debug panel) ──

export type TunableCrystallizeKey =
  | "messageThreshold"
  | "cooldownMs"
  | "salienceFloor"
  | "minUserChars";

export type TunableCrystallizeConfig = Partial<Record<TunableCrystallizeKey, number>>;

export type ChatSessionKind = "main" | "card" | "other";

export interface CrystallizeStateResponse {
  ok: boolean;
  state: {
    turn_count: number;
    last_crystallized_at: string | null;
    last_session_key: string | null;
    last_message_at: string | null;
  };
  settings: { auto_crystallize: boolean };
  config: {
    defaults: TunableCrystallizeConfig;
    override: TunableCrystallizeConfig;
    effective: TunableCrystallizeConfig;
    bounds: Record<TunableCrystallizeKey, { min: number; max: number; integer: boolean }>;
  };
  skillCounts: { active: number; disabled: number; total: number };
  recentDecisions: Array<{
    ts: string;
    decision: string;
    salience: number | null;
    summary: string;
    reason: string | null;
    memoryId: string | null;
    skillId: string | null;
    turnCount: number | null;
  }>;
  diagnostics: {
    lastSessionKey: string | null;
    lastSessionKind: ChatSessionKind | null;
    secondsSinceLastBump: number | null;
  };
}

export interface CrystallizeRunResponse {
  ok: boolean;
  result: {
    skipped: boolean;
    reason?: string;
    decision?: string;
    summary?: string;
    salience?: number;
    memoryId?: string;
    skillId?: string;
  };
}

export async function fetchCrystallizeState(signal?: AbortSignal): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/state", { signal });
  if (!res.ok) throw new Error(`/crystallize/state failed: ${res.status}`);
  return res.json();
}

export async function patchCrystallizeConfig(
  patch: Partial<Record<TunableCrystallizeKey, number | null>>,
): Promise<CrystallizeStateResponse> {
  const res = await proxyFetch("/crystallize/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/config failed: ${res.status} ${detail}`);
  }
  return res.json();
}

export async function setAutoCrystallize(enabled: boolean): Promise<void> {
  const res = await proxyPost("/settings/auto-crystallize", { enabled });
  if (!res.ok) throw new Error(`/settings/auto-crystallize failed: ${res.status}`);
}

export async function forceCrystallizeRun(): Promise<CrystallizeRunResponse> {
  const res = await proxyPost("/crystallize/run", {});
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/run failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// ── v3 Skills (debug panel) ──────────────────────────────────────────────
//
// Response shape matches plugin `routes/skills.ts` which serves v3 `skill_index`
// rows plus the `SKILL.md` body on detail requests. See
// `pinai-openclaw/plugins/proactive-ai/docs/memory-architecture.md` §三.

export type SkillStatus = "enabled" | "disabled" | "archived";

export interface Skill {
  id: string;
  title: string;
  description: string | null;
  status: SkillStatus;
  revision: number;
  body_hash: string;
  triggers: string[];
  source: string;
  created_run_id: string | null;
  last_updated_run_id: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  reference_count: number;
  last_referenced_at: string | null;
  referenced_by_runs: string[];
  /** Only populated on detail (GET /skills/:id) and after create/update. */
  body?: string;
}

export interface SkillCreateInput {
  title: string;
  body: string;
  description?: string | null;
  triggers?: string[];
  status?: "enabled" | "disabled";
}

export interface SkillPatch {
  title?: string;
  description?: string | null;
  body?: string;
  triggers?: string[];
  status?: SkillStatus;
}

export async function fetchSkills(
  params?: { status?: SkillStatus; limit?: number },
  signal?: AbortSignal,
): Promise<{ ok: boolean; skills: Skill[] }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/skills${suffix}`, { signal });
  if (!res.ok) throw new Error(`/skills failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function fetchSkill(id: string, signal?: AbortSignal): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`/skills/${id} failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function createSkill(input: SkillCreateInput): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyPost("/skills", input);
  if (!res.ok) throw new Error(`create skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

export async function updateSkill(id: string, patch: SkillPatch): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

/** Soft delete — backend flips status to 'archived'. */
export async function archiveSkill(id: string): Promise<{ ok: boolean; skill: Skill }> {
  const res = await proxyFetch(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`archive skill failed: ${await readErrorMessage(res)}`);
  return res.json();
}

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
  limit?: number;
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
): Promise<{ ok: boolean; memories: Memory[] }> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.subject) qs.set("subject", filter.subject);
  if (filter?.subjectPrefix) qs.set("subjectPrefix", filter.subjectPrefix);
  if (typeof filter?.minQuality === "number") qs.set("minQuality", String(filter.minQuality));
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.limit) qs.set("limit", String(filter.limit));
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
