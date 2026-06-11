import { proxyFetch, proxyPost } from "../transport/http";

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
  // Routes through the unified `/api/settings` PATCH-style endpoint.
  // Previously POST'd to `/settings/auto-crystallize` which was never
  // implemented on the backend (silent 404). Field name maps to the
  // `auto_crystallize` column on `pai_user_settings`.
  const res = await proxyPost("/settings", { autoCrystallize: enabled });
  if (!res.ok) throw new Error(`/settings failed: ${res.status}`);
}

export async function forceCrystallizeRun(): Promise<CrystallizeRunResponse> {
  const res = await proxyPost("/crystallize/run", {});
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`/crystallize/run failed: ${res.status} ${detail}`);
  }
  return res.json();
}
