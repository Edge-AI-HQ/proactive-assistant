import { accessToken, refreshAccessToken } from "@/auth/supabase";

// Local dashboard development should hit `/api/*` through Vite's same-origin
// proxy. Using the product app's VITE_PIN_API_URL here would make the browser
// call Fly directly and require CORS changes for every localhost port.
const PIN_API_BASE = (import.meta.env.VITE_REWARD_API_URL as string | undefined) || "";

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
  | "connectors"
  | "app_state";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const baseHeaders = (init?.headers as Record<string, string>) ?? {};
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...baseHeaders,
  };
  let res = await fetch(`${PIN_API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    const text = await res.text();
    if (text.includes("invalid Supabase token")) {
      const refreshedToken = await refreshAccessToken();
      if (refreshedToken && refreshedToken !== token) {
        res = await fetch(`${PIN_API_BASE}${path}`, {
          ...init,
          headers: {
            ...baseHeaders,
            Authorization: `Bearer ${refreshedToken}`,
          },
        });
      } else {
        throw new Error(text || "invalid Supabase token");
      }
    } else {
      throw new Error(text || `${res.status}`);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `${res.status}`);
  }
  return res.json() as Promise<T>;
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
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.trigger) qs.set("trigger", params.trigger);
  if (typeof params.reviewed === "boolean") qs.set("reviewed", String(params.reviewed));
  if (params.quality) qs.set("quality", params.quality);
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/runs${suffix}`);
}

export function listActiveAgentRuns(): Promise<{ ok: true; runs: AgentRunSummary[]; asOf: string }> {
  return request("/api/agent-runs/active");
}

export function getRun(runId: string): Promise<RunDetail> {
  return request(`/api/reward-dashboard/runs/${encodeURIComponent(runId)}`);
}

export function getCard(cardId: string): Promise<CardDetail> {
  return request(`/api/reward-dashboard/cards/${encodeURIComponent(cardId)}`);
}

export function scoreCard(
  cardId: string,
  score: number,
  reason?: string,
): Promise<{ ok: true; event: RewardEvent; card: CardDetail | null }> {
  return request(`/api/reward-dashboard/cards/${encodeURIComponent(cardId)}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "reviewer", eventType: "reviewer_score", score, reason }),
  });
}

export function upsertCasebook(
  cardId: string,
  label: CasebookLabel,
  reviewerNote: string,
): Promise<{ ok: true; casebook: CasebookEntry }> {
  return request(`/api/reward-dashboard/cards/${encodeURIComponent(cardId)}/casebook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, reviewerNote }),
  });
}

export function deleteCasebook(cardId: string): Promise<{ ok: true }> {
  return request(`/api/reward-dashboard/cards/${encodeURIComponent(cardId)}/casebook`, {
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
  if (params.label) qs.set("label", params.label);
  if (typeof params.minScore === "number") qs.set("minScore", String(params.minScore));
  if (typeof params.maxScore === "number") qs.set("maxScore", String(params.maxScore));
  if (params.basket) qs.set("basket", params.basket);
  if (params.intent) qs.set("intent", params.intent);
  if (typeof params.minEvaluatorGap === "number") {
    qs.set("minEvaluatorGap", String(params.minEvaluatorGap));
  }
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (typeof params.limit === "number") qs.set("limit", String(params.limit));
  if (typeof params.offset === "number") qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/casebook${suffix}`);
}

export function getTrace(runId: string): Promise<{ ok: true; trace: TraceArtifact }> {
  return request(`/api/reward-dashboard/runs/${encodeURIComponent(runId)}/trace`);
}

export function buildTrace(
  runId: string,
  force = false,
): Promise<{ ok: true; trace: TraceArtifact }> {
  return request(`/api/reward-dashboard/runs/${encodeURIComponent(runId)}/trace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
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
  return request("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardsToGenerate }),
  });
}

export function getMetrics(days = 14): Promise<MetricsResponse> {
  return request(`/api/reward-dashboard/metrics?days=${days}`);
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
  if (params.category && params.category !== "all") qs.set("category", params.category);
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (params.q) qs.set("q", params.q);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/reward-dashboard/personal-data${suffix}`);
}

export function scoreLabel(score: number | null | undefined): string {
  return typeof score === "number" && Number.isFinite(score) ? score.toFixed(1) : "-";
}

export function percentLabel(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
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

export function casebookMarkdown(items: CasebookEntry[]): string {
  return items.map((item) => {
    const card = item.snapshot.card;
    const evalScore = item.snapshot.evaluation?.overall;
    const note = item.reviewerNote?.trim() || "没有评审备注。";
    return [
      `### ${cardTitle(card)}`,
      "",
      `- 标签: ${casebookLabelText[item.label]}`,
      `- 保存分: ${scoreLabel(item.scoreSnapshot)}`,
      `- 评估分: ${scoreLabel(evalScore)}`,
      `- 卡片 ID: ${item.cardId}`,
      "",
      item.snapshot.card?.summary ?? "",
      "",
      `评审备注: ${note}`,
    ].join("\n");
  }).join("\n\n");
}
