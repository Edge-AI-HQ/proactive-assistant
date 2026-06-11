import { getTransportConfig } from "../transport/config";
import { readErrorMessage } from "../transport/errors";
import { proxyFetch } from "../transport/http";

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

export type PersonalSignalStatus = "open" | "consumed" | "archived";

export interface PersonalSignal {
  id: string;
  kind: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  source: string;
  device_id: string | null;
  subject: string | null;
  salience: number;
  confidence: number;
  status: PersonalSignalStatus;
  dedupe_key: string | null;
  occurred_at: string;
  available_at: string;
  expires_at: string | null;
  ingested_at: string;
  consumed_at: string | null;
  consumed_by_run_id: string | null;
  source_raw_table: string | null;
  source_raw_ids: string[];
  referenced_by_runs: string[];
}

export interface SignalListFilter {
  /** 'all' bypasses the server-side status filter (timeline view). */
  status?: PersonalSignalStatus | "all";
  kind?: string;
  source?: string;
  deviceId?: string;
  since?: string;
  until?: string;
  minSalience?: number;
  limit?: number;
  offset?: number;
  /**
   * Keyset cursor returned in `next_cursor`. Prefer this over `offset` for
   * timelines — it stays O(limit) regardless of how many pages back you go.
   */
  before?: string;
  pruneExpired?: boolean;
}

export interface SignalListResponse {
  ok: boolean;
  signals: PersonalSignal[];
  /** -1 when paginating by cursor (server skips the COUNT). */
  total: number;
  next_cursor: string | null;
  has_more: boolean;
}

type RawPersonalSignal = Partial<PersonalSignal> & {
  availableAt?: string;
  consumedAt?: string | null;
  consumedByRunId?: string | null;
  dedupeKey?: string | null;
  deviceId?: string | null;
  expiresAt?: string | null;
  ingestedAt?: string;
  occurredAt?: string;
  sourceRawIds?: string[];
  sourceRawTable?: string | null;
};

function normalizePersonalSignal(signal: RawPersonalSignal): PersonalSignal {
  return {
    id: signal.id ?? "",
    kind: signal.kind ?? "",
    title: signal.title ?? "",
    summary: signal.summary ?? "",
    payload: signal.payload ?? {},
    source: signal.source ?? "",
    device_id: signal.device_id ?? signal.deviceId ?? null,
    subject: signal.subject ?? null,
    salience: typeof signal.salience === "number" ? signal.salience : 0,
    confidence: typeof signal.confidence === "number" ? signal.confidence : 0,
    status: signal.status ?? "open",
    dedupe_key: signal.dedupe_key ?? signal.dedupeKey ?? null,
    occurred_at: signal.occurred_at ?? signal.occurredAt ?? "",
    available_at: signal.available_at ?? signal.availableAt ?? signal.occurred_at ?? signal.occurredAt ?? "",
    expires_at: signal.expires_at ?? signal.expiresAt ?? null,
    ingested_at: signal.ingested_at ?? signal.ingestedAt ?? "",
    consumed_at: signal.consumed_at ?? signal.consumedAt ?? null,
    consumed_by_run_id: signal.consumed_by_run_id ?? signal.consumedByRunId ?? null,
    source_raw_table: signal.source_raw_table ?? signal.sourceRawTable ?? null,
    source_raw_ids: signal.source_raw_ids ?? signal.sourceRawIds ?? [],
    referenced_by_runs: signal.referenced_by_runs ?? [],
  };
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

export async function fetchProfileSnapshot(
  signal?: AbortSignal,
): Promise<ProfileSnapshot> {
  // Client hints（locale/timezone）按平台注入 —— web 用 navigator，RN 用原生模块。
  const res = await proxyFetch("/profile", {
    signal,
    headers: getTransportConfig().clientHintHeaders?.() ?? {},
  });
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

export async function fetchSignals(
  filter?: SignalListFilter,
  signal?: AbortSignal,
): Promise<SignalListResponse> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.kind) qs.set("kind", filter.kind);
  if (filter?.source) qs.set("source", filter.source);
  if (filter?.deviceId) qs.set("deviceId", filter.deviceId);
  if (filter?.since) qs.set("since", filter.since);
  if (filter?.until) qs.set("until", filter.until);
  if (typeof filter?.minSalience === "number") qs.set("minSalience", String(filter.minSalience));
  if (filter?.limit) qs.set("limit", String(filter.limit));
  if (typeof filter?.offset === "number") qs.set("offset", String(filter.offset));
  if (filter?.before) qs.set("before", filter.before);
  if (filter?.pruneExpired) qs.set("pruneExpired", "1");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await proxyFetch(`/signals${suffix}`, { signal });
  if (!res.ok) throw new Error(`/signals failed: ${await readErrorMessage(res)}`);
  const data = (await res.json()) as Partial<SignalListResponse>;
  return {
    ok: data.ok ?? false,
    signals: Array.isArray(data.signals)
      ? data.signals.map((signal) => normalizePersonalSignal(signal as RawPersonalSignal))
      : [],
    total: typeof data.total === "number" ? data.total : -1,
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more ?? false,
  };
}
