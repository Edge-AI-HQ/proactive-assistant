import { accessToken, refreshAccessToken } from "@/auth/supabase";
import { dashboardDisplayId, dashboardMarkdownLink, firstDashboardRouteId } from "@/lib/dashboardRoutes";
import { redactSensitiveText } from "@/lib/redaction";
import { REWARD_TEXT_FILTER_MAX_LENGTH } from "@/lib/textFilter";

export { REWARD_TEXT_FILTER_MAX_LENGTH } from "@/lib/textFilter";

// Local dashboard development should hit `/api/*` through Vite's same-origin
// proxy. Using the product app's VITE_PIN_API_URL here would make the browser
// call Fly directly and require CORS changes for every localhost port.
const PIN_API_BASE = (import.meta.env.VITE_REWARD_API_URL as string | undefined) || "";

export const CASEBOOK_OFFSET_MAX = 10_000;
export const CASEBOOK_REVIEWER_NOTE_MAX_LENGTH = 2_000;
export const PERSONAL_DATA_OFFSET_MAX = 10_000;
export const PERSONAL_DATA_QUERY_MAX_LENGTH = 200;
export const SCORE_REASON_MAX_LENGTH = 1_000;

export type TraceStatus = "pending" | "ready" | "missing" | "failed";
export type CasebookLabel =
  | "great"
  | "bad"
  | "surprising"
  | "generic"
  | "hallucinated"
  | "duplicate"
  | "mistimed"
  | "weak_source";

const casebookLabelValues = new Set<string>([
  "great",
  "bad",
  "surprising",
  "generic",
  "hallucinated",
  "duplicate",
  "mistimed",
  "weak_source",
]);
const runQualityValues = new Set<string>(["aha", "dead", "reviewer_aha"]);

export interface RunSummary {
  id: string;
  runId: string;
  status: string | null;
  trigger: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cardCount: number;
  avgUserReward: number | null;
  avgReviewerReward: number | null;
  deadCardRate: number | null;
  ahaRate: number | null;
  reviewedCount: number;
  casebookCount: number;
  avgEvaluatorOverall: number | null;
  traceStatus: TraceStatus;
  reviewLatencyHours: number | null;
  attempts?: number;
  maxAttempts?: number;
  lastError?: string | null;
}

export interface AgentRunSummary {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
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

export interface RewardEvent {
  id: string;
  runId: string;
  cardId: string;
  source: "user" | "reviewer" | "system";
  eventType: string;
  score: number | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Evaluation {
  cardId: string;
  runId: string;
  intentKey: string | null;
  basket: string | null;
  dimensions: {
    relevance: number | null;
    actionability: number | null;
    whyNowClarity: number | null;
    novelty: number | null;
    decisionCompression: number | null;
  };
  overall: number | null;
  pass: boolean;
  evaluator: string | null;
  feedback: string | null;
  evaluatedAt: string | null;
}

export interface CardSnapshot {
  id: string;
  intentKey?: string;
  intent_key?: string;
  goalBasket?: string;
  goal_basket?: string;
  title?: string;
  summary?: string;
  whyNow?: string;
  why_now?: string;
  primaryAction?: { label?: string };
  sources?: string[];
  [key: string]: unknown;
}

export interface RewardSummary {
  userReward: number;
  reviewerReward: number | null;
  displayReward: number;
  opened: boolean;
  latestUserScoreAt: string | null;
  latestReviewerScoreAt: string | null;
}

export interface CasebookEntry {
  id: string;
  runId: string;
  cardId: string;
  label: CasebookLabel;
  scoreSnapshot: number | null;
  reviewerNote: string | null;
  snapshot: {
    card?: CardSnapshot;
    evaluation?: Evaluation | null;
    rewards?: RewardSummary;
    sources?: string[];
    run?: RewardRun;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RewardRun {
  id: string;
  runId: string;
  status: string | null;
  trigger: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalIterations: number | null;
  error: string | null;
}

export interface RewardCardDetail {
  card: CardSnapshot;
  evaluation: Evaluation | null;
  rewards: RewardSummary;
  rewardHistory: RewardEvent[];
  casebook: CasebookEntry | null;
  feedbackEvents: Array<Record<string, unknown>>;
}

export interface RunDetail {
  ok: true;
  run: RewardRun;
  cards: RewardCardDetail[];
  trace: TraceArtifact | null;
}

export interface CardDetail extends RewardCardDetail {
  ok: true;
  run: RewardRun;
  trace: TraceArtifact | null;
  relatedCards: Array<{ runId: string; completedAt: string | null; card: CardSnapshot }>;
}

export interface TraceArtifact {
  runId: string;
  langsmithTraceId?: string | null;
  langsmithUrl?: string | null;
  status: TraceStatus;
  traceTree: { svg?: string; nodes?: Array<Record<string, unknown>>; [key: string]: unknown };
  summary: Record<string, unknown>;
  imageFormat?: "svg" | "png";
  imagePath?: string | null;
  error?: string | null;
  generatedAt?: string | null;
}

export interface MetricsResponse {
  ok: true;
  days: number;
  series: Array<{
    day: string;
    cardCount: number;
    avgUserReward: number | null;
    avgReviewerReward: number | null;
    deadCardRate: number | null;
    ahaRate: number | null;
    reviewedCount: number;
    casebookGrowth: number;
  }>;
}

export type PersonalDataCategory =
  | "all"
  | "profile"
  | "goals"
  | "settings"
  | "memory"
  | "skills"
  | "signals"
  | "world"
  | "raw"
  | "devices"
  | "connectors";

const personalDataCategoryValues = new Set<string>([
  "all",
  "profile",
  "goals",
  "settings",
  "memory",
  "skills",
  "signals",
  "world",
  "raw",
  "devices",
  "connectors",
]);

export interface PersonalDataItem {
  id: string;
  category: PersonalDataCategory;
  sourceKey: string;
  sourceLabel: string;
  kind: string | null;
  title: string;
  subtitle: string | null;
  summary: string | null;
  status: string | null;
  score: number | null;
  occurredAt: string | null;
  updatedAt: string | null;
  chips: string[];
  payload: Record<string, unknown> | unknown[] | string | null;
}

export interface PersonalDataSection {
  key: PersonalDataCategory;
  label: string;
  description: string;
  total: number;
  items: PersonalDataItem[];
}

export interface PersonalDataResponse {
  ok: true;
  filters: {
    category: PersonalDataCategory;
    since: string | null;
    until: string | null;
    query: string | null;
    limit: number;
    offset: number;
  };
  totals: Record<string, number>;
  sections: PersonalDataSection[];
}

function stringifyDetail(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => stringifyDetail(item))
      .filter((item): item is string => item !== null);
    return lines.length > 0 ? lines.join("; ") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message =
      stringifyDetail(record.detail) ??
      stringifyDetail(record.message) ??
      stringifyDetail(record.error);
    if (message) {
      return message;
    }
    const validationMessage = stringifyDetail(record.msg);
    if (validationMessage) {
      const loc = Array.isArray(record.loc)
        ? record.loc
          .map((part) => String(part))
          .filter((part) => part.trim().length > 0)
          .join(".")
        : "";
      return loc ? `${loc}: ${validationMessage}` : validationMessage;
    }
  }
  return null;
}

export function apiErrorMessage(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return `HTTP ${status}`;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return stringifyDetail(parsed) ?? `HTTP ${status}`;
  } catch {
    return trimmed;
  }
}

// Dev-only marker recognized by the backend `current_user` dep when
// DEPLOY_ENV=dev. Mirrors `_DEV_AUTH_BYPASS_HEADER_VALUE` in
// pinai-agents/.../web/auth/deps.py. Inert outside DEV builds + outside
// DEPLOY_ENV=dev backends.
const DEV_AUTH_BYPASS_VALUE = "pinai-dev-reviewer";

function devAuthBypassActive(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const search = new URLSearchParams(window.location.search);
  if (search.get("__devAuthBypass") === "1") return true;
  try {
    return window.localStorage.getItem("__devAuthBypass") === "1";
  } catch {
    return false;
  }
}

function requestHeaders(input: HeadersInit | undefined, token: string | null): Headers {
  const headers = new Headers(input);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (devAuthBypassActive()) {
    headers.set("X-Dev-Auth", DEV_AUTH_BYPASS_VALUE);
  }
  return headers;
}

function encodedApiId(value: string, label: string): string {
  const id = firstDashboardRouteId(value);
  if (!id) {
    throw new Error(`${label} 缺失，不能发起请求。`);
  }
  return encodeURIComponent(id);
}

function setFiniteNumberParam(
  qs: URLSearchParams,
  name: string,
  value: number | undefined,
  options: { integer?: boolean; min?: number; max?: number } = {},
) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  if (options.integer && !Number.isInteger(value)) return;
  if (typeof options.min === "number" && value < options.min) return;
  if (typeof options.max === "number" && value > options.max) return;
  qs.set(name, String(value));
}

function setTrimmedStringParam(
  qs: URLSearchParams,
  name: string,
  value: string | undefined,
  options: { maxLength?: number } = {},
) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (typeof options.maxLength === "number" && trimmed.length > options.maxLength) return;
  qs.set(name, trimmed);
}

function setEnumParam(qs: URLSearchParams, name: string, value: string | undefined, allowed: ReadonlySet<string>) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!allowed.has(trimmed)) return;
  qs.set(name, trimmed);
}

function finiteIntegerOrFallback(value: number, fallback: number, options: { min?: number; max?: number } = {}): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (typeof options.min === "number" && value < options.min) return fallback;
  if (typeof options.max === "number" && value > options.max) return fallback;
  return value;
}

function reviewerScoreValue(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error("人工评分必须是 1 到 10 之间的数字。");
  }
  return value;
}

function casebookLabelValue(value: CasebookLabel): CasebookLabel {
  if (typeof value !== "string" || !casebookLabelValues.has(value)) {
    throw new Error("样本库标签无效，不能发起请求。");
  }
  return value;
}

function boundedMutationText(
  value: string | undefined,
  label: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  }
  return trimmed;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const headers = requestHeaders(init?.headers, token);
  let res = await fetch(`${PIN_API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    const text = await res.text();
    const message = apiErrorMessage(res.status, text);
    if (text.includes("invalid Supabase token") || message.includes("invalid Supabase token")) {
      const refreshedToken = await refreshAccessToken();
      if (refreshedToken && refreshedToken !== token) {
        res = await fetch(`${PIN_API_BASE}${path}`, {
          ...init,
          headers: requestHeaders(init?.headers, refreshedToken),
        });
      } else {
        throw new Error(message);
      }
    } else {
      throw new Error(message);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(apiErrorMessage(res.status, text));
  }
  return res.json() as Promise<T>;
}

// ── Internal-operator impersonation + preferences ──
// The dashboard authenticates as the internal operator (Supabase). To read
// or補 a TARGET user's preferences, it first mints a per-run token bound to
// that user (server-tagged actor='internal_operator'), then calls the
// per-user agent endpoints WITH that token as the bearer (not the operator's
// Supabase token).

export interface ImpersonationToken {
  token: string;
  runId: string;
  userId: number;
}

export type PreferenceScope = "topic" | "source" | "timing" | "format" | "global";
export type PreferencePolarity = "positive" | "negative";
export type PreferenceDurability = "temporary" | "persistent";

export interface PreferenceRecord {
  id: string;
  statement: string;
  scope: PreferenceScope;
  polarity: PreferencePolarity;
  weight: number;
  confidence: number | null;
  source: string;
  evidence: Record<string, unknown>;
  durability: PreferenceDurability;
  expires_at: string | null;
  status: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Fetch with an explicit bearer (the minted impersonation token), bypassing
 *  the Supabase-token injection `request()` does. Still attaches X-Dev-Auth
 *  in a dev bypass build so local verification works. */
async function requestWithBearer<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (devAuthBypassActive()) {
    headers.set("X-Dev-Auth", DEV_AUTH_BYPASS_VALUE);
  }
  const res = await fetch(`${PIN_API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(apiErrorMessage(res.status, text));
  }
  return res.json() as Promise<T>;
}

export function mintImpersonationToken(
  targetSupabaseUserId: string,
): Promise<ImpersonationToken> {
  return request("/api/reward-dashboard/impersonate/chat-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetSupabaseUserId }),
  });
}

export async function listTargetPreferences(token: string): Promise<PreferenceRecord[]> {
  const payload = await requestWithBearer<{ items: PreferenceRecord[] }>(
    "/api/agent/preferences/list?status=active",
    token,
  );
  return payload.items ?? [];
}

export function addTargetPreference(
  token: string,
  input: { statement: string; scope: PreferenceScope; polarity: PreferencePolarity },
): Promise<PreferenceRecord> {
  return requestWithBearer("/api/agent/preferences/add", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function listRuns(params: {
  limit?: number;
  trigger?: string;
  reviewed?: boolean;
  quality?: "aha" | "dead" | "reviewer_aha";
  since?: string;
  until?: string;
} = {}): Promise<{ ok: true; runs: RunSummary[] }> {
  const qs = new URLSearchParams();
  setFiniteNumberParam(qs, "limit", params.limit, { integer: true, min: 1, max: 200 });
  setTrimmedStringParam(qs, "trigger", params.trigger, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  if (typeof params.reviewed === "boolean") qs.set("reviewed", String(params.reviewed));
  setEnumParam(qs, "quality", params.quality, runQualityValues);
  setTrimmedStringParam(qs, "since", params.since, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setTrimmedStringParam(qs, "until", params.until, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/runs${suffix}`);
}

export function listActiveAgentRuns(): Promise<{ ok: true; runs: AgentRunSummary[]; asOf: string }> {
  return request("/api/agent-runs/active");
}

export function getRun(runId: string): Promise<RunDetail> {
  return request(`/api/reward-dashboard/runs/${encodedApiId(runId, "批次 ID")}`);
}

export function getCard(cardId: string): Promise<CardDetail> {
  return request(`/api/reward-dashboard/cards/${encodedApiId(cardId, "卡片 ID")}`);
}

export function scoreCard(
  cardId: string,
  score: number,
  reason?: string,
): Promise<{ ok: true; event: RewardEvent; card: CardDetail | null }> {
  const safeScore = reviewerScoreValue(score);
  const safeReason = boundedMutationText(reason, "评分原因", SCORE_REASON_MAX_LENGTH);
  return request(`/api/reward-dashboard/cards/${encodedApiId(cardId, "卡片 ID")}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "reviewer", eventType: "reviewer_score", score: safeScore, reason: safeReason }),
  });
}

export function upsertCasebook(
  cardId: string,
  label: CasebookLabel,
  reviewerNote: string,
): Promise<{ ok: true; casebook: CasebookEntry }> {
  const safeLabel = casebookLabelValue(label);
  const safeReviewerNote = boundedMutationText(
    reviewerNote,
    "样本库评审备注",
    CASEBOOK_REVIEWER_NOTE_MAX_LENGTH,
  );
  return request(`/api/reward-dashboard/cards/${encodedApiId(cardId, "卡片 ID")}/casebook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: safeLabel, reviewerNote: safeReviewerNote ?? null }),
  });
}

export function deleteCasebook(cardId: string): Promise<{ ok: true }> {
  return request(`/api/reward-dashboard/cards/${encodedApiId(cardId, "卡片 ID")}/casebook`, {
    method: "DELETE",
  });
}

export function listCasebook(params: {
  label?: string;
  minScore?: number;
  maxScore?: number;
  basket?: string;
  intent?: string;
  minEvaluatorGap?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ ok: true; items: CasebookEntry[]; total: number; limit: number; offset: number }> {
  const qs = new URLSearchParams();
  setEnumParam(qs, "label", params.label, casebookLabelValues);
  setFiniteNumberParam(qs, "minScore", params.minScore, { min: 0, max: 10 });
  setFiniteNumberParam(qs, "maxScore", params.maxScore, { min: 0, max: 10 });
  setTrimmedStringParam(qs, "basket", params.basket, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setTrimmedStringParam(qs, "intent", params.intent, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setFiniteNumberParam(qs, "minEvaluatorGap", params.minEvaluatorGap, { min: 0, max: 10 });
  setTrimmedStringParam(qs, "since", params.since, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setTrimmedStringParam(qs, "until", params.until, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setFiniteNumberParam(qs, "limit", params.limit, { integer: true, min: 1, max: 200 });
  setFiniteNumberParam(qs, "offset", params.offset, { integer: true, min: 0, max: CASEBOOK_OFFSET_MAX });
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/casebook${suffix}`);
}

export function getTrace(runId: string): Promise<{ ok: true; trace: TraceArtifact }> {
  return request(`/api/reward-dashboard/runs/${encodedApiId(runId, "批次 ID")}/trace`);
}

export function buildTrace(
  runId: string,
  force = false,
): Promise<{ ok: true; trace: TraceArtifact }> {
  const safeForce = force === true;
  return request(`/api/reward-dashboard/runs/${encodedApiId(runId, "批次 ID")}/trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: safeForce }),
  });
}

export function triggerGenerate(cardsToGenerate = 8): Promise<{
  ok: true;
  taskId: string;
  runId: string;
  status: string;
  asOf: string;
  deduped?: boolean;
}> {
  const safeCardsToGenerate = finiteIntegerOrFallback(cardsToGenerate, 8, { min: 1, max: 10 });
  return request("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardsToGenerate: safeCardsToGenerate }),
  });
}

export function getMetrics(days = 14): Promise<MetricsResponse> {
  const qs = new URLSearchParams();
  setFiniteNumberParam(qs, "days", days, { integer: true, min: 1, max: 90 });
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/metrics${suffix}`);
}

export type PatternStatus = "pending_review" | "active" | "retired";
export type PatternTier = "cold_start_friendly" | "warmup" | "mature";
export type PatternSurpriseLevel = "h" | "m" | "l";

const patternStatusValues = new Set<string>(["pending_review", "active", "retired"]);
const patternTierValues = new Set<string>(["cold_start_friendly", "warmup", "mature"]);
const patternSurpriseValues = new Set<string>(["h", "m", "l"]);

export interface PatternSummary {
  id: string;
  category: string;
  abstract: string;
  humanInsight: string;
  signalsRequired: string[];
  triggerDsl: unknown[];
  intent: string;
  cardSkeleton: Record<string, unknown>;
  specializations: unknown[];
  surpriseInit: PatternSurpriseLevel | null;
  practicalInit: PatternSurpriseLevel | null;
  tier: PatternTier;
  status: PatternStatus;
  source: "seed" | "ai_extracted" | "manual";
  baseHitRate: number;
  demoTitle: string | null;
  demoCardCategory: string | null;
  demoHumanNeed: string | null;
  demoEntryPoint: string | null;
  demoSourceDataSummary: string[];
  createdAt: string | null;
  updatedAt: string | null;
  retiredAt: string | null;
}

export interface PatternDemo {
  id: string;
  patternId: string;
  subtype: string | null;
  scenario: string;
  card: Record<string, unknown>;
  signalsUsed: string[];
  whySurprise: string | null;
  whyPractical: string | null;
  wowLevel: number | null;
  source: "seed" | "golden" | "anti";
  redacted: boolean;
  sourceCardId: string | null;
  createdAt: string | null;
}

export interface PatternListResponse {
  ok: true;
  items: PatternSummary[];
  total: number;
  limit: number;
  offset: number;
  facets: { categories: string[]; intents: string[] };
}

export interface PatternRecentHit {
  userId: number;
  runId: string;
  cardId: string;
  subtype: string | null;
  evidence: Record<string, unknown>;
  combinedScore: number | null;
  patternGroundingOk: boolean | null;
  opened: boolean;
  reviewerScore: number | null;
  evaluatorOverall: number | null;
  evaluatorHumanGap: number | null;
  createdAt: string | null;
}

export interface PatternDetailResponse {
  ok: true;
  pattern: PatternSummary;
  demos: PatternDemo[];
  recentHits: PatternRecentHit[];
  health: PatternHealthRow | null;
}

export function listPatterns(
  params: {
    category?: string;
    status?: PatternStatus;
    surprise?: PatternSurpriseLevel;
    tier?: PatternTier;
    intent?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<PatternListResponse> {
  const qs = new URLSearchParams();
  setTrimmedStringParam(qs, "category", params.category, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setEnumParam(qs, "status", params.status, patternStatusValues);
  setEnumParam(qs, "surprise", params.surprise, patternSurpriseValues);
  setEnumParam(qs, "tier", params.tier, patternTierValues);
  setTrimmedStringParam(qs, "intent", params.intent, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setFiniteNumberParam(qs, "limit", params.limit, { integer: true, min: 1, max: 500 });
  setFiniteNumberParam(qs, "offset", params.offset, { integer: true, min: 0, max: 10_000 });
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/patterns${suffix}`);
}

export function getPattern(patternId: string): Promise<PatternDetailResponse> {
  return request(`/api/reward-dashboard/patterns/${encodedApiId(patternId, "Pattern ID")}`);
}

export interface PatternUpdateInput {
  abstract?: string;
  humanInsight?: string;
  category?: string;
  intent?: string;
  tier?: PatternTier;
  surpriseInit?: PatternSurpriseLevel;
  practicalInit?: PatternSurpriseLevel;
  signalsRequired?: unknown[];
  triggerDsl?: unknown[];
  cardSkeleton?: Record<string, unknown>;
  specializations?: unknown[];
}

export function updatePattern(
  patternId: string, body: PatternUpdateInput,
): Promise<{ ok: true; pattern: PatternSummary }> {
  return request(`/api/reward-dashboard/patterns/${encodedApiId(patternId, "Pattern ID")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function setPatternStatus(
  patternId: string, status: PatternStatus,
): Promise<{ ok: true; pattern: PatternSummary }> {
  return request(`/api/reward-dashboard/patterns/${encodedApiId(patternId, "Pattern ID")}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export interface DemoPromotionInput {
  source: "golden" | "anti";
  scenario?: string;
  cardId?: string;
  card?: Record<string, unknown>;
  signalsUsed?: string[];
  whySurprise?: string;
  whyPractical?: string;
  wowLevel?: number;
  subtype?: string;
}

export function addPatternDemo(
  patternId: string, body: DemoPromotionInput,
): Promise<{ ok: true; demo: PatternDemo }> {
  return request(`/api/reward-dashboard/patterns/${encodedApiId(patternId, "Pattern ID")}/demos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function listPendingPatterns(): Promise<{ ok: true; items: PatternSummary[] }> {
  return request("/api/reward-dashboard/patterns/pending");
}

export interface PatternExtractSummary {
  ok: true;
  lookback_days: number;
  min_cluster_size: number;
  golden_cards_seen: number;
  clusters_total: number;
  clusters_above_min: number;
  candidates_inserted: number;
  candidates: Array<{
    patternId: string;
    intentKey: string;
    clusterSize: number;
    sampleCardIds: string[];
    abstract: string;
  }>;
}

export function runPatternExtractor(
  params: { lookbackDays?: number; minClusterSize?: number } = {},
): Promise<PatternExtractSummary> {
  const body: Record<string, number> = {};
  if (typeof params.lookbackDays === "number") body.lookbackDays = params.lookbackDays;
  if (typeof params.minClusterSize === "number") body.minClusterSize = params.minClusterSize;
  return request("/api/reward-dashboard/patterns/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function approvePendingPattern(
  patternId: string,
): Promise<{ ok: true; pattern: PatternSummary }> {
  return request(
    `/api/reward-dashboard/patterns/pending/${encodedApiId(patternId, "Pattern ID")}/approve`,
    { method: "POST" },
  );
}

export function rejectPendingPattern(
  patternId: string,
): Promise<{ ok: true; deleted: boolean }> {
  return request(
    `/api/reward-dashboard/patterns/pending/${encodedApiId(patternId, "Pattern ID")}/reject`,
    { method: "POST" },
  );
}

export interface PatternHealthRow {
  patternId: string;
  category: string;
  status: PatternStatus;
  hitCount7d: number;
  hitCount30d: number;
  dismissCount30d: number;
  hitRate7d: number | null;
  hitRate30d: number | null;
  hitRate30dTrend: number | null;
  dismissRate30d: number | null;
  evaluatorHumanGapMean: number | null;
  baseHitRate: number;
  shouldRetire: boolean;
  retireReasons: string[];
}

export function getPatternsHealth(): Promise<{ ok: true; items: PatternHealthRow[] }> {
  return request("/api/reward-dashboard/patterns/health");
}

export function runPatternsHealthJob(): Promise<{
  ok: true; updates: number; retires: number; total: number;
}> {
  return request("/api/reward-dashboard/patterns/health/run", { method: "POST" });
}


export function getPersonalData(params: {
  category?: PersonalDataCategory;
  since?: string;
  until?: string;
  q?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<PersonalDataResponse> {
  const qs = new URLSearchParams();
  if (params.category !== "all") setEnumParam(qs, "category", params.category, personalDataCategoryValues);
  setTrimmedStringParam(qs, "since", params.since, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setTrimmedStringParam(qs, "until", params.until, { maxLength: REWARD_TEXT_FILTER_MAX_LENGTH });
  setTrimmedStringParam(qs, "q", params.q, { maxLength: PERSONAL_DATA_QUERY_MAX_LENGTH });
  setFiniteNumberParam(qs, "limit", params.limit, { integer: true, min: 5, max: 200 });
  setFiniteNumberParam(qs, "offset", params.offset, { integer: true, min: 0, max: PERSONAL_DATA_OFFSET_MAX });
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/personal-data${suffix}`);
}

export function scoreLabel(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? score.toFixed(1) : "-";
}

export function percentLabel(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? `${Math.round(value * 100)}%`
    : "-";
}

export function cardTitle(card: CardSnapshot | undefined): string {
  return typeof card?.title === "string" && card.title.trim() ? card.title : "未命名卡片";
}

const casebookLabelText: Record<CasebookLabel, string> = {
  bad: "坏样本",
  duplicate: "重复",
  generic: "泛化",
  great: "好样本",
  hallucinated: "幻觉",
  mistimed: "时机不对",
  surprising: "惊喜",
  weak_source: "证据弱",
};

function casebookLabelName(label: string | null | undefined): string {
  if (!label) return "未标记";
  const trimmed = label.trim();
  if (!trimmed) return "未标记";
  return casebookLabelText[trimmed as CasebookLabel] ?? markdownText(trimmed, "未标记", 120);
}

function hasFiniteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function markdownText(value: unknown, fallback: string, limit = 600): string {
  if (typeof value !== "string") return fallback;
  const text = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}...`;
}

function markdownCardTitle(card: CardSnapshot | undefined): string {
  return markdownText(card?.title, "未命名卡片", 140);
}

function markdownSourceLine(value: string): string {
  return `- ${markdownText(value, "没有保存证据引用。", 320)}`;
}

function markdownSources(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((source): source is string => typeof source === "string" && source.trim().length > 0)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function markdownRunCards(detail: Pick<RunDetail, "cards">): RunDetail["cards"] {
  const cards = detail.cards as unknown;
  return Array.isArray(cards)
    ? cards.filter((entry): entry is RunDetail["cards"][number] => {
        const record = recordValue(entry);
        return record !== null && recordValue(record.card) !== null && recordValue(record.rewards) !== null;
      })
    : [];
}

export function casebookMarkdown(items: CasebookEntry[]): string {
  return items.map((item) => {
    const card = item.snapshot.card;
    const evalScore = item.snapshot.evaluation?.overall;
    const note = markdownText(item.reviewerNote, "没有评审备注。", 600);
    const cardRouteId = firstDashboardRouteId(item.cardId, card?.id);
    const runRouteId = firstDashboardRouteId(item.snapshot.run?.id, item.runId);
    const traceRouteId = firstDashboardRouteId(item.snapshot.run?.runId, item.runId);
    const allSources = Array.isArray(item.snapshot.sources)
      ? markdownSources(item.snapshot.sources)
      : markdownSources(item.snapshot.card?.sources);
    const sources = allSources.slice(0, 5);
    const sourceLines = sources.map(markdownSourceLine);
    if (allSources.length > sources.length) {
      sourceLines.push(`- 还有 ${allSources.length - sources.length} 条证据未写入复制摘要，请回到页面继续查看。`);
    }
    return [
      `### ${markdownCardTitle(card)}`,
      "",
      `- 标签: ${casebookLabelName(item.label)}`,
      `- 保存分: ${scoreLabel(item.scoreSnapshot)}`,
      `- 评估分: ${scoreLabel(evalScore)}`,
      `- 卡片 ID: ${dashboardDisplayId(cardRouteId)}`,
      `- 卡片详情: ${dashboardMarkdownLink("card", cardRouteId)}`,
      `- 原批次: ${dashboardMarkdownLink("run", runRouteId)}`,
      `- 生成链路: ${dashboardMarkdownLink("trace", traceRouteId)}`,
      "",
      "#### 摘要",
      markdownText(item.snapshot.card?.summary, "没有保存摘要。", 800),
      "",
      "#### 证据引用",
      sourceLines.length > 0 ? sourceLines.join("\n") : "- 没有保存证据引用。",
      "",
      "#### 评审备注",
      `评审备注: ${note}`,
    ].join("\n");
  }).join("\n\n");
}

export function cardReviewMarkdown(detail: CardDetail, routeCardId?: string): string {
  const card = detail.card;
  const allSources = markdownSources(card.sources);
  const sources = allSources.slice(0, 6);
  const sourceLines = sources.map(markdownSourceLine);
  if (allSources.length > sources.length) {
    sourceLines.push(`- 还有 ${allSources.length - sources.length} 条证据未写入复制摘要，请回到单卡页面继续查看。`);
  }
  const cardRouteId = firstDashboardRouteId(card.id, routeCardId);
  const runRouteId = firstDashboardRouteId(detail.run.id, detail.run.runId);
  const traceRouteId = firstDashboardRouteId(detail.run.runId, detail.run.id);
  return [
    `### 单卡复盘 ${markdownCardTitle(card)}`,
    "",
    `- 卡片 ID: ${dashboardDisplayId(cardRouteId)}`,
    `- 卡片详情: ${dashboardMarkdownLink("card", cardRouteId)}`,
    `- 原批次: ${dashboardMarkdownLink("run", runRouteId)}`,
    `- 生成链路: ${dashboardMarkdownLink("trace", traceRouteId)}`,
    `- 用户分: ${scoreLabel(detail.rewards.userReward)}`,
    `- 人工分: ${scoreLabel(detail.rewards.reviewerReward)}`,
    `- 评估分: ${scoreLabel(detail.evaluation?.overall)}`,
    `- 样本库: ${detail.casebook ? casebookLabelName(detail.casebook.label) : "未保存"}`,
    "",
    "#### 摘要",
    markdownText(card.summary, "没有保存摘要。", 800),
    "",
    "#### 为什么现在",
    markdownText(card.whyNow ?? card.why_now, "没有保存时机说明。", 800),
    "",
    "#### 证据引用",
    sourceLines.length > 0 ? sourceLines.join("\n") : "- 没有保存证据引用。",
    "",
    "#### 评估器反馈",
    markdownText(detail.evaluation?.feedback, "没有评估器反馈。", 800),
  ].join("\n");
}

function averageScore(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

export function runReviewMarkdown(detail: RunDetail, routeRunId?: string): string {
  const cards = markdownRunCards(detail);
  const reviewedCount = cards.filter((entry) => hasFiniteScore(entry.rewards.reviewerReward)).length;
  const casebookCount = cards.filter((entry) => entry.casebook).length;
  const topCards = cards.slice(0, 8);
  const remainingCards = Math.max(0, cards.length - topCards.length);
  const runRouteId = firstDashboardRouteId(detail.run.id, routeRunId, detail.run.runId);
  const traceRouteId = firstDashboardRouteId(detail.run.runId, routeRunId, detail.run.id);
  return [
    `### 批次复盘 ${dashboardDisplayId(detail.run.runId, routeRunId, detail.run.id)}`,
    "",
    `- 批次评审: ${dashboardMarkdownLink("run", runRouteId)}`,
    `- 生成链路: ${dashboardMarkdownLink("trace", traceRouteId)}`,
    `- 状态: ${markdownText(detail.run.status, "-", 120)}`,
    `- 触发来源: ${markdownText(detail.run.trigger, "-", 120)}`,
    `- 卡片数: ${cards.length}`,
    `- 人工评审: ${reviewedCount}/${cards.length}`,
    `- 人工平均分: ${scoreLabel(averageScore(cards.map((entry) => entry.rewards.reviewerReward)))}`,
    `- 评估平均分: ${scoreLabel(averageScore(cards.map((entry) => entry.evaluation?.overall)))}`,
    `- 已入样本库: ${casebookCount}`,
    "",
    "#### 卡片列表",
    topCards.length > 0
      ? topCards.map((entry, index) => [
          `${index + 1}. ${markdownCardTitle(entry.card)}`,
          `   - 卡片详情: ${dashboardMarkdownLink("card", entry.card.id)}`,
          `   - 用户/人工/评估: ${scoreLabel(entry.rewards.userReward)} / ${scoreLabel(entry.rewards.reviewerReward)} / ${scoreLabel(entry.evaluation?.overall)}`,
          `   - 样本库: ${entry.casebook ? casebookLabelName(entry.casebook.label) : "未保存"}`,
          `   - 摘要: ${markdownText(entry.card.summary, "没有保存摘要。", 320)}`,
        ].join("\n")).join("\n")
      : "- 当前批次没有保存卡片。",
    remainingCards > 0 ? `\n- 还有 ${remainingCards} 张卡未写入复制摘要，请回到批次页面继续查看。` : "",
  ].join("\n");
}
