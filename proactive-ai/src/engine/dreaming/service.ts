import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  type CoreContext,
  PinDatabaseManager,
  ProfileRepository,
  createPersonalProvider,
  feedback,
  profile,
  appPaths,
  resolveAppRootFromCtx,
} from "../../core/index.js";
import { detectAgentErrorInMessages, parseAgentJson } from "../pipeline/agent-output.js";
import { loadRunStore } from "../pipeline/run-store.js";
import { DreamRunStore, type DreamProfileDelta, type DreamRunRecord, type DreamSummary } from "./store.js";

export type DreamSourceStatus = "ok" | "skipped" | "error";

export interface DreamSourceResult {
  status: DreamSourceStatus;
  count: number;
  raw: unknown;
  normalized: unknown;
  message?: string;
}

export interface DreamSourceDefinition {
  id: string;
  collect(input: {
    ctx: CoreContext;
    windowStart: string;
    windowEnd: string;
    profile: Record<string, unknown>;
  }): Promise<DreamSourceResult>;
}

export interface DreamRunDetail {
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  summary: DreamSummary;
  dreamMarkdownPath: string | null;
  dreamMarkdown: string;
  profileDelta: DreamProfileDelta;
  candidates: Array<Record<string, unknown>>;
  sourceBreakdown: Array<{
    sourceId: string;
    status: DreamSourceStatus;
    itemCount: number;
    reason?: string;
    connectors?: Array<{
      connectorId: string;
      status: DreamSourceStatus;
      itemCount: number;
      reason?: string;
    }>;
  }>;
  logPath: string | null;
  logText: string;
}

interface DreamExecutionContext {
  store: DreamRunStore;
  run: DreamRunRecord;
  ctx: CoreContext;
  api?: OpenClawPluginApi;
  now: Date;
  windowStart: string;
  windowEnd: string;
  sources?: DreamSourceDefinition[];
  runDir: string;
  runLogPath: string;
  rootLogPath: string;
}

interface RunDreamingInput {
  ctx: CoreContext;
  trigger: "auto" | "manual";
  api?: OpenClawPluginApi;
  now?: Date;
  sources?: DreamSourceDefinition[];
}

interface ApplyDreamProfileInput {
  ctx: CoreContext;
  runId: string;
}

const DREAMS_DIR_NAME = "dreams";
const DREAMS_LOGS_DIR_NAME = "logs";
const DREAM_RUN_LOG_FILE_NAME = "events.log";
const DREAM_RUN_MARKDOWN_FILE_NAME = "dream.md";
const DREAM_ROOT_MARKDOWN_FILE_NAME = "dreaming.md";
const MAX_STORED_DREAM_RUNS = 30;
const DEFAULT_PROFILE_ID = "default";
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const DREAM_SUMMARIZER_TIMEOUT_MS = 180_000;

interface DreamSynthesis {
  summary?: {
    kind?: DreamSummary["kind"];
    text?: string;
    highlights?: string[];
  };
  highlights?: string[];
  candidateCards?: Array<Record<string, unknown>>;
  journalMarkdown?: string;
  interestTopics?: string[];
}

function getDreamsDir(root: string): string {
  return join(root, DREAMS_DIR_NAME);
}

function getDreamsLogsDir(root: string): string {
  return join(getDreamsDir(root), DREAMS_LOGS_DIR_NAME);
}

function formatReadableDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDreamDay(now: Date): string {
  return `${now.getFullYear()}-${formatReadableDatePart(now.getMonth() + 1)}-${formatReadableDatePart(now.getDate())}`;
}

function nextReadableRunSequence(dayDir: string, dayKey: string): string {
  if (!existsSync(dayDir)) return "01";
  const matches = readdirSync(dayDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const match = entry.name.match(new RegExp(`^${dayKey}-(\\d{2})-(manual|auto)(-.+)?$`));
      return match ? Number(match[1]) : 0;
    })
    .filter((value) => value > 0);
  const next = (matches.length > 0 ? Math.max(...matches) : 0) + 1;
  return formatReadableDatePart(next);
}

function createReadableRunDir(root: string, now: Date, trigger: "auto" | "manual", runId: string): string {
  const dreamsDir = getDreamsDir(root);
  const dayKey = formatDreamDay(now);
  const dayDir = join(dreamsDir, dayKey);
  ensureDir(dayDir);
  const sequence = nextReadableRunSequence(dayDir, dayKey);
  return join(dayDir, `${dayKey}-${sequence}-${trigger}-${runId}`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function getNowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

async function createProfileRepository(ctx: CoreContext): Promise<ProfileRepository> {
  const root = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(root);
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
}

async function getDefaultProfileRecord(ctx: CoreContext): Promise<Record<string, unknown>> {
  return await profile.getProfile(ctx, DEFAULT_PROFILE_ID, true) as Record<string, unknown>;
}

function parseArtifact<T>(artifactDir: string, name: string): T {
  return JSON.parse(readFileSync(join(artifactDir, name), "utf-8")) as T;
}

function parseArtifactIfExists<T>(artifactDir: string, name: string, fallback: T): T {
  const path = join(artifactDir, name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readTextIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function extractAgentText(messages: { messages: unknown[] }): string {
  const assistantMessages = (messages.messages as Array<{ role?: string; content?: unknown }>)
    .filter((message) => message.role === "assistant");
  const last = assistantMessages[assistantMessages.length - 1];
  if (!last?.content) return "";
  if (typeof last.content === "string") return last.content.trim();
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

function clampWindowStart(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

function emptyProfileDelta(): DreamProfileDelta {
  return {
    facts: { before: {}, after: {} },
    preferences: { before: {}, after: {} },
    interests: { before: [], after: [] },
    snapshots: { before: [], after: [] },
  };
}

function resolveDreamingLanguage(ctx: CoreContext, currentProfile: Record<string, unknown>): unknown {
  const root = resolveAppRootFromCtx(ctx);
  const settingsPath = appPaths.localSettings(root);
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        generation?: { language?: unknown };
      };
      const language = parsed?.generation?.language;
      if (typeof language === "string" && language.trim()) {
        return language;
      }
    } catch {
      // Fall back to profile locale.
    }
  }
  return currentProfile.locale;
}

function appendDreamLog(path: string, line: string): void {
  appendFileSync(path, `${line}\n`);
}

function logDreamEvent(input: DreamExecutionContext, message: string, extra?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    runId: input.run.id,
    trigger: input.run.trigger,
    message,
    ...(extra ? { extra } : {}),
  };
  const line = JSON.stringify(payload);
  appendDreamLog(input.runLogPath, line);
  appendDreamLog(input.rootLogPath, line);
}

function inferItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  let count = 0;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) {
      count += entry.length;
    }
  }
  return count;
}

function buildSourceBreakdown(
  sourceId: string,
  result: DreamSourceResult,
): {
  sourceId: string;
  status: DreamSourceStatus;
  itemCount: number;
  reason?: string;
  connectors?: Array<{
    connectorId: string;
    status: DreamSourceStatus;
    itemCount: number;
    reason?: string;
  }>;
} {
  const breakdown = {
    sourceId,
    status: result.status,
    itemCount: result.count,
    ...(result.message ? { reason: result.message } : {}),
  };

  if (sourceId !== "personal") return breakdown;

  const connectors = (result.raw as { connectors?: Record<string, unknown> } | null)?.connectors;
  if (!connectors || typeof connectors !== "object") return breakdown;

  return {
    ...breakdown,
    connectors: Object.entries(connectors).map(([connectorId, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value) && "status" in value) {
        const record = value as { status?: DreamSourceStatus; reason?: string };
        return {
          connectorId,
          status: record.status ?? "ok",
          itemCount: inferItemCount(value),
          ...(record.reason ? { reason: record.reason } : {}),
        };
      }

      const itemCount = inferItemCount(value);
      return {
        connectorId,
        status: itemCount > 0 ? "ok" : "skipped",
        itemCount,
        ...(itemCount > 0 ? {} : { reason: "No new connector data" }),
      };
    }),
  };
}

function buildSourceBreakdownFromStored(
  sourceStats: Record<string, { status?: DreamSourceStatus; count?: number; message?: string }>,
  rawInputs: Record<string, unknown>,
): DreamRunDetail["sourceBreakdown"] {
  return Object.entries(sourceStats).map(([sourceId, value]) => {
    if (sourceId !== "personal") {
      return {
        sourceId,
        status: value.status ?? "skipped",
        itemCount: Number(value.count ?? 0),
        ...(value.message ? { reason: value.message } : {}),
      };
    }

    const connectors = (rawInputs.personal as { connectors?: Record<string, unknown> } | null)?.connectors;
    if (!connectors || typeof connectors !== "object") {
      return {
        sourceId,
        status: value.status ?? "skipped",
        itemCount: Number(value.count ?? 0),
        ...(value.message ? { reason: value.message } : {}),
      };
    }

    return {
      sourceId,
      status: value.status ?? "skipped",
      itemCount: Number(value.count ?? 0),
      ...(value.message ? { reason: value.message } : {}),
      connectors: Object.entries(connectors).map(([connectorId, connectorValue]) => {
        if (connectorValue && typeof connectorValue === "object" && !Array.isArray(connectorValue) && "status" in connectorValue) {
          const record = connectorValue as { status?: DreamSourceStatus; reason?: string };
          return {
            connectorId,
            status: record.status ?? "ok",
            itemCount: inferItemCount(connectorValue),
            ...(record.reason ? { reason: record.reason } : {}),
          };
        }

        const itemCount = inferItemCount(connectorValue);
        return {
          connectorId,
          status: itemCount > 0 ? "ok" : "skipped",
          itemCount,
          ...(itemCount > 0 ? {} : { reason: "No new connector data" }),
        };
      }),
    };
  });
}

function compactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > 0 ? compacted : null;
}

function truncateText(value: string | null, maxLength = 600): string | null {
  if (!value) return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function joinContextParts(parts: Array<unknown>): string | null {
  const values = parts
    .map((value) => compactText(value))
    .filter((value): value is string => !!value);
  if (values.length === 0) return null;
  return values.join(" | ");
}

function createInterestRecords(topics: string[], fallbackTimestamp: string): Array<Record<string, unknown>> {
  return topics
    .map((topic) => compactText(topic)?.toLowerCase())
    .filter((topic): topic is string => !!topic)
    .filter((topic, index, list) => list.indexOf(topic) === index)
    .slice(0, 5)
    .map((key, index) => ({
      id: `dream_interest_${index}_${key}`,
      kind: "topic",
      key,
      score: 0.8,
      confidence: 0.8,
      evidenceCount: 1,
      lastSignalAt: fallbackTimestamp,
      status: "active",
    }));
}

function parseIso(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toRelativeSince(windowStart: string, windowEnd: string): string {
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  if (!start || !end) return "24h";
  const diffMs = Math.max(MS_PER_HOUR, end.getTime() - start.getTime());
  const hours = Math.max(1, Math.ceil(diffMs / MS_PER_HOUR));
  if (hours <= 48) return `${hours}h`;
  const days = Math.max(1, Math.ceil(diffMs / MS_PER_DAY));
  if (days <= 21) return `${days}d`;
  return `${Math.max(1, Math.ceil(days / 7))}w`;
}

function buildMinimalSummary(
  sourceStats: Record<string, Record<string, unknown>>,
  locale?: unknown,
): DreamSummary {
  const totalCount = Object.values(sourceStats).reduce((sum, stat) => sum + Number(stat.count ?? 0), 0);
  const activeSourceEntries = Object.entries(sourceStats)
    .filter(([, stat]) => stat.status === "ok" && Number(stat.count ?? 0) > 0);
  const activeSources = activeSourceEntries.length;
  const isZh = isChineseLocale(locale);

  if (totalCount === 0) {
    return {
      kind: "no_new_data",
      text: isZh
        ? "这次 dreaming 在最近的时间窗口里没有发现新的有效数据。"
        : "Dreaming found no new data in the latest window.",
      sourceCount: activeSources,
      candidateCount: 0,
      highlights: [],
    };
  }

  const sourceList = activeSourceEntries.map(([sourceId]) => sourceId).join(", ");
  return {
    kind: "updated",
    text: isZh
      ? `本次 Dreaming 采集了 ${totalCount} 条近期内容，来自 ${activeSources} 个活跃来源${sourceList ? `（${sourceList}）` : ""}。等待子代理进一步总结这些上下文。`
      : `Dreaming collected ${totalCount} recent items across ${activeSources} active sources${sourceList ? ` (${sourceList})` : ""}. Waiting for subagent synthesis.`,
    sourceCount: activeSources,
    candidateCount: 0,
    highlights: [],
  };
}

function buildProfileDelta(
  currentProfile: Record<string, unknown>,
  sourceStats: Record<string, Record<string, unknown>>,
  summary: DreamSummary,
  candidates: Array<Record<string, unknown>>,
  normalizedInputs: Record<string, unknown>,
  nowIso: string,
  windowStart: string,
  windowEnd: string,
  options?: {
    highlights?: string[];
    interestTopics?: string[];
  },
): DreamProfileDelta {
  const currentFacts = (currentProfile.facts ?? {}) as Record<string, unknown>;
  const currentPreferences = (currentProfile.preferences ?? {}) as Record<string, unknown>;
  const currentInterests = ((currentProfile.interests ?? []) as Array<Record<string, unknown>>);
  const currentSnapshots = ((currentProfile.snapshots ?? []) as Array<Record<string, unknown>>);
  const highlights = options?.highlights?.length ? options.highlights : [];

  const factsAfter = {
    ...currentFacts,
    dreaming: {
      lastRunAt: nowIso,
      lastWindowStart: windowStart,
      lastWindowEnd: windowEnd,
      lastSummaryKind: summary.kind,
      lastCandidateCount: candidates.length,
      latestHighlights: highlights,
      latestCandidates: candidates.map((candidate) => ({
        title: candidate.title,
        basket: candidate.basket,
      })),
      sourceStats,
    },
  };

  const preferencesAfter = {
    ...currentPreferences,
    dreaming: {
      lastUpdatedAt: nowIso,
    },
  };

  const derivedInterests = options?.interestTopics?.length
    ? createInterestRecords(options.interestTopics, nowIso)
    : [];
  const interestsAfter = derivedInterests.length > 0 ? derivedInterests : currentInterests;

  const snapshotsAfter = [
    ...currentSnapshots,
    {
      view: "dreaming",
      generatedAt: nowIso,
      summary: summary.text,
      kind: summary.kind,
      candidateCount: candidates.length,
      highlights,
      candidateTitles: candidates.map((candidate) => candidate.title),
      sourceStats,
    },
  ];

  return {
    facts: { before: currentFacts, after: factsAfter },
    preferences: { before: currentPreferences, after: preferencesAfter },
    interests: { before: currentInterests, after: interestsAfter },
    snapshots: { before: currentSnapshots, after: snapshotsAfter },
  };
}

function isChineseLocale(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith("zh");
}

function buildMinimalDreamJournal(input: {
  locale: unknown;
  summary: DreamSummary;
  trigger: "auto" | "manual";
  startedAt: string;
}): string {
  const isZh = isChineseLocale(input.locale);
  const runLabel = `${input.startedAt.slice(0, 10)} · ${input.trigger}`;

  if (isZh) {
    return [
      "# Dreaming Journal",
      "",
      `## ${runLabel}`,
      "",
      "本次 Dreaming 记录已经生成，但当前仅保留原始上下文采集结果，语义总结等待子代理完成或重试。",
      "",
      `当前状态：${typeof input.summary.text === "string" ? input.summary.text : "暂无额外说明。"}`,
      "",
    ].join("\n");
  }

  return [
    "# Dreaming Journal",
    "",
    `## ${runLabel}`,
    "",
    "This Dreaming entry currently records collected context only. Semantic follow-up is deferred to the subagent result or a later retry.",
    "",
    `Current status: ${typeof input.summary.text === "string" ? input.summary.text : "No additional note."}`,
    "",
  ].join("\n");
}

function buildDreamingPrompt(input: {
  locale: unknown;
  trigger: "auto" | "manual";
  startedAt: string;
  windowStart: string;
  windowEnd: string;
  currentProfile: Record<string, unknown>;
  sourceStats: Record<string, Record<string, unknown>>;
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  mode?: "primary" | "deep_retry";
}): string {
  const language = isChineseLocale(input.locale) ? "Simplified Chinese" : "English";
  const deepRetryInstruction = input.mode === "deep_retry"
    ? `
This is a second-pass deep review because the first pass was too conservative.
There ARE concrete personal items in the window. You must dig deeper like a sharp chief of staff:
- Look again for actionable implications in email bodies, calendar events, titles, timestamps, and cross-source overlap.
- Do not dismiss the window as no_new_data unless every concrete item is clearly trivial.
- If you still conclude no_new_data, explain specifically why each concrete personal thread is not actionable.
`
    : "";
  return `You are a Dreaming Agent for a proactive personal assistant.

Your job is to think like a strong executive assistant or chief of staff, not a logger.
You are reviewing the user's recent context across all connected data sources.
Do not merely restate each record. Synthesize what actually matters.

Write all prose in ${language}. Raw source titles, IDs, URLs, and proper nouns may remain in their original language when needed.

Priorities:
1. Identify the most meaningful cross-source threads, obligations, deadlines, and opportunities.
2. Prefer concrete real-world items from email, calendar, notes, Slack, and recent cards over generic observations.
3. Avoid noise, newsletters, obvious spam, and low-signal trivia unless they clearly matter.
4. Produce assistant-style output that helps the system remember and follow up later.
${deepRetryInstruction}

You will receive:
- current profile
- source stats
- raw inputs
- normalized inputs

Output ONLY a JSON code block with this exact shape:
\`\`\`json
{
  "summary": {
    "kind": "updated" | "no_new_data",
    "text": "One concise high-level summary",
    "highlights": ["highlight 1", "highlight 2"]
  },
  "highlights": ["highlight 1", "highlight 2"],
  "candidateCards": [
    {
      "title": "Concrete follow-up title",
      "basket": "work|health|family|wealth|growth|life",
      "reason": "Why this matters now",
      "connector": "gmail|googlecalendar|notion|slack|dreaming|other"
    }
  ],
  "interestTopics": ["topic1", "topic2"],
  "journalMarkdown": "# Dreaming Journal\\n\\n## YYYY-MM-DD · manual|auto\\n\\nNatural assistant-style diary entry"
}
\`\`\`

Constraints:
- Prefer 0-3 candidate cards, only when genuinely useful.
- journalMarkdown must sound like a personal assistant reflecting on the user's day.
- highlights should be concrete, not generic categories.
- If the window has no meaningful new signal, return kind=no_new_data and empty arrays.

Current run context:
\`\`\`json
${JSON.stringify({
    trigger: input.trigger,
    startedAt: input.startedAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    currentProfile: input.currentProfile,
    sourceStats: input.sourceStats,
    rawInputs: input.rawInputs,
    normalizedInputs: input.normalizedInputs,
  }, null, 2)}
\`\`\`
`;
}

function sanitizeDreamCandidates(
  candidates: unknown,
  fallbackTimestamp: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .slice(0, 3)
    .map((item, index) => ({
      id: `dream_candidate_${index + 1}`,
      title: compactText(item.title) ?? `Dream follow-up ${index + 1}`,
      basket: compactText(item.basket) ?? "life",
      reason: compactText(item.reason) ?? "Dreaming identified this as worth following up.",
      connector: compactText(item.connector) ?? "dreaming",
      source: "dreaming",
      createdAt: fallbackTimestamp,
    }));
}

function normalizeDreamSummaryFromModel(
  synthesis: DreamSynthesis,
  fallback: DreamSummary,
): DreamSummary {
  const kind = synthesis.summary?.kind === "no_new_data" ? "no_new_data" : synthesis.summary?.kind === "updated" ? "updated" : fallback.kind;
  const text = compactText(synthesis.summary?.text) ?? fallback.text;
  const highlights = Array.isArray(synthesis.highlights)
    ? synthesis.highlights.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5)
    : Array.isArray(synthesis.summary?.highlights)
      ? synthesis.summary!.highlights!.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5)
      : fallback.highlights ?? [];
  return {
    kind,
    text,
    sourceCount: fallback.sourceCount,
    candidateCount: fallback.candidateCount,
    highlights,
  };
}

async function runDreamingSummarizer(
  api: OpenClawPluginApi,
  input: {
    locale: unknown;
    trigger: "auto" | "manual";
    startedAt: string;
    windowStart: string;
    windowEnd: string;
    currentProfile: Record<string, unknown>;
    sourceStats: Record<string, Record<string, unknown>>;
    rawInputs: Record<string, unknown>;
    normalizedInputs: Record<string, unknown>;
    mode?: "primary" | "deep_retry";
  },
): Promise<DreamSynthesis> {
  const sessionKey = `agent:dreaming:proactive-ai:${Date.now().toString(36)}`;
  const prompt = buildDreamingPrompt(input);
  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: prompt,
    idempotencyKey: `proactive-ai:dreaming:${Date.now().toString(36)}`,
    message: "Review the full dream context and return the required JSON.",
    deliver: false,
  });

  try {
    const result = await api.runtime.subagent.waitForRun({
      runId,
      timeoutMs: DREAM_SUMMARIZER_TIMEOUT_MS,
    });
    if (result.status !== "ok") {
      throw new Error(`Dreaming summarizer failed with status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
    }
    const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
    const messageError = detectAgentErrorInMessages(messages.messages);
    if (messageError) {
      throw new Error(`Dreaming summarizer failed: ${messageError}`);
    }
    const text = extractAgentText(messages);
    const parsed = parseAgentJson<DreamSynthesis>(text);
    if (!parsed) {
      throw new Error(`Dreaming summarizer returned invalid JSON: ${text.slice(0, 200)}`);
    }
    return parsed;
  } finally {
    await api.runtime.subagent.deleteSession({
      sessionKey,
      deleteTranscript: false,
    }).catch(() => {});
  }
}

function writeArtifacts(
  artifactDir: string,
  payload: {
    meta: Record<string, unknown>;
    rawInputs: Record<string, unknown>;
    normalizedInputs: Record<string, unknown>;
    summary: DreamSummary;
    profileDelta: DreamProfileDelta;
    candidates: Array<Record<string, unknown>>;
  },
): string {
  ensureDir(artifactDir);
  writeFileSync(join(artifactDir, "meta.json"), JSON.stringify(payload.meta, null, 2));
  writeFileSync(join(artifactDir, "inputs.raw.json"), JSON.stringify(payload.rawInputs, null, 2));
  writeFileSync(join(artifactDir, "inputs.normalized.json"), JSON.stringify(payload.normalizedInputs, null, 2));
  writeFileSync(join(artifactDir, "summary.json"), JSON.stringify(payload.summary, null, 2));
  writeFileSync(join(artifactDir, "profile-delta.json"), JSON.stringify(payload.profileDelta, null, 2));
  writeFileSync(join(artifactDir, "candidates.json"), JSON.stringify(payload.candidates, null, 2));
  return artifactDir;
}

function writeDreamMarkdown(root: string, artifactDir: string, markdown: string): string {
  const runMarkdownPath = join(artifactDir, DREAM_RUN_MARKDOWN_FILE_NAME);
  writeFileSync(runMarkdownPath, markdown);
  const journalPath = join(getDreamsDir(root), DREAM_ROOT_MARKDOWN_FILE_NAME);
  if (!existsSync(journalPath)) {
    writeFileSync(journalPath, markdown);
    return runMarkdownPath;
  }
  appendFileSync(journalPath, `\n---\n\n${markdown}`);
  return runMarkdownPath;
}

async function collectSignals(ctx: CoreContext, windowStart: string): Promise<DreamSourceResult> {
  const repository = await createProfileRepository(ctx);
  const signals = await repository.listSignals(DEFAULT_PROFILE_ID);
  const filtered = (signals ?? []).filter((signal) => signal.occurredAt >= windowStart);
  return { status: "ok", count: filtered.length, raw: filtered, normalized: filtered };
}

async function collectFeedback(ctx: CoreContext, windowStart: string, windowEnd: string): Promise<DreamSourceResult> {
  const rows = await feedback.listFeedback(ctx, { since: toRelativeSince(windowStart, windowEnd), limit: "50" });
  return { status: "ok", count: rows.length, raw: rows, normalized: rows };
}

function normalizeGoogleCalendarSummaryView(summaryView: string, windowEnd: string): Array<Record<string, unknown>> {
  return summaryView
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10)
    .map((line, index) => ({
      connector: "googlecalendar",
      title: line.replace(/^\d+[\.\)]\s*/, ""),
      timestamp: windowEnd,
      rank: index + 1,
    }));
}

function normalizeGmailEntries(data: unknown, windowEnd: string): Array<Record<string, unknown>> {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const items = arrayOfObjects(root?.messages ?? data);
  return items.slice(0, 20).map((item) => {
    const preview = item.preview && typeof item.preview === "object" && !Array.isArray(item.preview)
      ? item.preview as Record<string, unknown>
      : {};
    const title = compactText(item.subject) ?? compactText(preview.subject) ?? "Recent email";
    const body = truncateText(compactText(item.messageText), 1600);
    const previewBody = truncateText(compactText(preview.body) ?? compactText(item.snippet), 600);
    const sender = compactText(item.sender) ?? compactText(item.from);
    const labels = normalizeStringArray(item.labelIds ?? item.labels);
    return {
      connector: "gmail",
      title,
      timestamp: compactText(item.internalDate) ?? compactText(item.messageTimestamp) ?? compactText(item.date) ?? windowEnd,
      sender,
      to: compactText(item.to),
      preview: previewBody,
      body,
      labels,
      messageId: compactText(item.messageId),
      threadId: compactText(item.threadId),
      displayUrl: compactText(item.display_url),
      context: joinContextParts([
        title,
        sender,
        previewBody,
        body,
        labels.join(" "),
      ]),
    };
  });
}

function normalizeGoogleCalendarEntries(data: unknown, windowEnd: string): Array<Record<string, unknown>> {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const summaryView = root?.summary_view;
  if (typeof summaryView === "string") {
    return normalizeGoogleCalendarSummaryView(summaryView, windowEnd);
  }

  const summaryEntries = arrayOfObjects(summaryView);
  if (summaryEntries.length > 0) {
    return summaryEntries.slice(0, 20).map((item, index) => {
      const title = compactText(item.title) ?? compactText(item.summary) ?? "Calendar event";
      const calendar = compactText(item.calendar);
      const start = compactText(item.start) ?? windowEnd;
      const end = compactText(item.end);
      const details = joinContextParts([title, calendar, start, end, compactText(item.location), compactText(item.description)]);
      return {
        connector: "googlecalendar",
        title,
        timestamp: start,
        start,
        end,
        calendar,
        isAllDay: Boolean(item.is_all_day),
        location: compactText(item.location),
        description: truncateText(compactText(item.description), 600),
        eventId: compactText(item.event_id),
        displayUrl: compactText(item.display_url),
        rank: index + 1,
        context: details,
      };
    });
  }

  const items = arrayOfObjects(root?.items ?? root?.events ?? data);
  return items.slice(0, 20).map((item) => {
    const start = compactText(item.start) ?? compactText((item.start as Record<string, unknown> | undefined)?.dateTime)
      ?? compactText((item.start as Record<string, unknown> | undefined)?.date) ?? windowEnd;
    const end = compactText(item.end) ?? compactText((item.end as Record<string, unknown> | undefined)?.dateTime)
      ?? compactText((item.end as Record<string, unknown> | undefined)?.date) ?? null;
    const title = compactText(item.title) ?? compactText(item.summary) ?? "Calendar event";
    const calendar = compactText(item.calendar) ?? compactText((item.organizer as Record<string, unknown> | undefined)?.email);
    return {
      connector: "googlecalendar",
      title,
      timestamp: start,
      start,
      end,
      calendar,
      isAllDay: Boolean((item.start as Record<string, unknown> | undefined)?.date),
      location: compactText(item.location),
      description: truncateText(compactText(item.description), 600),
      displayUrl: compactText(item.display_url) ?? compactText(item.htmlLink),
      attendees: arrayOfObjects(item.attendees).map((attendee) => compactText(attendee.email) ?? compactText(attendee.displayName)).filter((value): value is string => !!value),
      context: joinContextParts([
        title,
        calendar,
        start,
        end,
        compactText(item.location),
        compactText(item.description),
      ]),
    };
  });
}

function normalizeNotionEntries(data: unknown, windowEnd: string): Array<Record<string, unknown>> {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const items = arrayOfObjects(root?.items ?? root?.results ?? data);
  return items.slice(0, 20).map((item) => {
    const title = compactText(item.title) ?? compactText(item.name) ?? compactText(item.page_title) ?? "Notion item";
    const preview = truncateText(
      compactText(item.summary) ?? compactText(item.preview) ?? compactText(item.snippet) ?? compactText(item.text),
      600,
    );
    return {
      connector: "notion",
      title,
      timestamp: compactText(item.last_edited_time) ?? compactText(item.updated_at) ?? compactText(item.created_time) ?? windowEnd,
      pageId: compactText(item.id),
      objectType: compactText(item.object) ?? compactText(item.type),
      url: compactText(item.url),
      preview,
      context: joinContextParts([
        title,
        preview,
        compactText(item.object),
        compactText(item.type),
      ]),
    };
  });
}

async function collectCards(windowStart: string): Promise<DreamSourceResult> {
  const runs = loadRunStore().runs.filter((run) => run.completedAt >= windowStart);
  const cards = runs.flatMap((run) =>
    (run.finalCards ?? []).map((card) => ({
      runId: run.id,
      completedAt: run.completedAt,
      ...((card as Record<string, unknown>) ?? {}),
    })),
  );
  return { status: cards.length > 0 ? "ok" : "skipped", count: cards.length, raw: cards, normalized: cards, message: cards.length > 0 ? undefined : "No recent cards" };
}

async function collectPersonal(ctx: CoreContext, windowStart: string, windowEnd: string): Promise<DreamSourceResult> {
  const provider = createPersonalProvider(ctx);
  const connections = await provider.discoverConnections();
  const active = connections.filter((item) => item.status === "ACTIVE");
  const connectors: Record<string, unknown> = {};
  const normalized: Array<Record<string, unknown>> = [];

  const tryExecute = async (tool: string, args: Record<string, unknown>, connectedAccountId?: string | null) => {
    const result = await provider.executeTool(tool, args, connectedAccountId ?? undefined);
    return result.success ? result.data : null;
  };

  const appendConnector = (toolkit: string, data: unknown) => {
    const existing = connectors[toolkit];
    connectors[toolkit] = Array.isArray(existing) ? [...existing, data] : [data];
  };

  for (const connection of active) {
    const accountId = connection.connectedAccountId;
    try {
      if (connection.toolkit === "gmail") {
        const data = await tryExecute("GMAIL_FETCH_EMAILS", {}, accountId);
        appendConnector("gmail", data ?? []);
        normalized.push(...normalizeGmailEntries(data, windowEnd));
        continue;
      }

      if (connection.toolkit === "googlecalendar") {
        const data = await tryExecute("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", {
          time_min: windowStart,
          time_max: windowEnd,
        }, accountId);
        appendConnector("googlecalendar", data ?? []);
        normalized.push(...normalizeGoogleCalendarEntries(data, windowEnd));
        continue;
      }

      if (connection.toolkit === "notion") {
        const data = await tryExecute("NOTION_FETCH_DATA", {}, accountId);
        appendConnector("notion", data ?? []);
        normalized.push(...normalizeNotionEntries(data, windowEnd));
        continue;
      }

      if (connection.toolkit === "slack") {
        connectors.slack = { status: "skipped", reason: "Slack adapter not yet stabilized" };
        continue;
      }

      connectors[connection.toolkit] = { status: "skipped", reason: "No adapter registered" };
    } catch (error) {
      connectors[connection.toolkit] = {
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const count = normalized.length;
  return {
    status: count > 0 ? "ok" : "skipped",
    count,
    raw: { connectors },
    normalized,
    message: count > 0 ? undefined : "No personal connector data collected",
  };
}

function createDefaultSources(): DreamSourceDefinition[] {
  return [
    {
      id: "personal",
      async collect({ ctx, windowStart, windowEnd }) {
        return await collectPersonal(ctx, windowStart, windowEnd);
      },
    },
    {
      id: "signals",
      async collect({ ctx, windowStart }) {
        return await collectSignals(ctx, windowStart);
      },
    },
    {
      id: "feedback",
      async collect({ ctx, windowStart, windowEnd }) {
        return await collectFeedback(ctx, windowStart, windowEnd);
      },
    },
    {
      id: "cards",
      async collect({ windowStart }) {
        return await collectCards(windowStart);
      },
    },
  ];
}

function hasConcretePersonalContext(normalizedInputs: Record<string, unknown>): boolean {
  const personalEntries = Array.isArray(normalizedInputs.personal)
    ? normalizedInputs.personal as Array<Record<string, unknown>>
    : [];
  return personalEntries.some((entry) =>
    typeof entry.title === "string"
    || typeof entry.context === "string"
    || typeof entry.preview === "string"
    || typeof entry.body === "string",
  );
}

function createDreamExecutionContext(input: RunDreamingInput): DreamExecutionContext {
  const root = resolveAppRootFromCtx(input.ctx);
  ensureDir(getDreamsDir(root));
  ensureDir(getDreamsLogsDir(root));
  const store = new DreamRunStore(root);
  const now = input.now ?? new Date();
  const windowEnd = now.toISOString();
  const windowStart = clampWindowStart(now);
  const run = store.createRun({
    trigger: input.trigger,
    windowStart,
    windowEnd,
  });
  const runDir = createReadableRunDir(root, now, run.trigger, run.id);
  ensureDir(runDir);
  const runLogPath = join(runDir, DREAM_RUN_LOG_FILE_NAME);
  const rootLogPath = join(getDreamsLogsDir(root), `${formatDreamDay(now)}.log`);
  return {
    store,
    run,
    ctx: input.ctx,
    api: input.api,
    now,
    windowStart,
    windowEnd,
    sources: input.sources,
    runDir,
    runLogPath,
    rootLogPath,
  };
}

async function executeDreaming(input: DreamExecutionContext): Promise<{ run: DreamRunRecord; detail: DreamRunDetail }> {
  const root = resolveAppRootFromCtx(input.ctx);
  try {
    logDreamEvent(input, "run_started", {
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    });
    const currentProfile = await getDefaultProfileRecord(input.ctx);
    const dreamingLanguage = resolveDreamingLanguage(input.ctx, currentProfile);
    const sources = input.sources ?? createDefaultSources();
    const rawInputs: Record<string, unknown> = {};
    const normalizedInputs: Record<string, unknown> = {};
    const sourceStats: Record<string, Record<string, unknown>> = {};
    const sourceBreakdown: DreamRunDetail["sourceBreakdown"] = [];

    for (const source of sources) {
      try {
        logDreamEvent(input, "source_collect_started", { sourceId: source.id });
        const result = await source.collect({
          ctx: input.ctx,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          profile: currentProfile,
        });
        rawInputs[source.id] = result.raw;
        normalizedInputs[source.id] = result.normalized;
        sourceStats[source.id] = {
          status: result.status,
          count: result.count,
          ...(result.message ? { message: result.message } : {}),
        };
        const breakdown = buildSourceBreakdown(source.id, result);
        sourceBreakdown.push(breakdown);
        logDreamEvent(input, "source_collect_completed", breakdown);
      } catch (error) {
        rawInputs[source.id] = [];
        normalizedInputs[source.id] = [];
        sourceStats[source.id] = {
          status: "error",
          count: 0,
          message: error instanceof Error ? error.message : String(error),
        };
        const breakdown = {
          sourceId: source.id,
          status: "error" as const,
          itemCount: 0,
          reason: error instanceof Error ? error.message : String(error),
        };
        sourceBreakdown.push(breakdown);
        logDreamEvent(input, "source_collect_failed", breakdown);
      }
    }

    const nowIso = getNowIso(input.now);
    const fallbackHighlights: string[] = [];
    const fallbackCandidates: Array<Record<string, unknown>> = [];
    const fallbackSummary = buildMinimalSummary(sourceStats, dreamingLanguage);
    let highlights = fallbackHighlights;
    let candidates = fallbackCandidates;
    let summary = fallbackSummary;
    let markdown: string | null = null;
    let interestTopics: string[] | undefined;

    if (input.api) {
      try {
        logDreamEvent(input, "summarizer_started", { strategy: "subagent" });
        const synthesis = await runDreamingSummarizer(input.api, {
          locale: dreamingLanguage,
          trigger: input.run.trigger,
          startedAt: input.run.startedAt,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          currentProfile,
          sourceStats,
          rawInputs,
          normalizedInputs,
          mode: "primary",
        });
        candidates = sanitizeDreamCandidates(synthesis.candidateCards, nowIso);
        summary = normalizeDreamSummaryFromModel(synthesis, {
          ...buildMinimalSummary(sourceStats, dreamingLanguage),
          candidateCount: candidates.length,
        });
        highlights = Array.isArray(summary.highlights)
          ? summary.highlights.filter((item): item is string => typeof item === "string")
          : fallbackHighlights;
        markdown = typeof synthesis.journalMarkdown === "string" && synthesis.journalMarkdown.trim().length > 0
          ? synthesis.journalMarkdown.trim()
          : null;
        interestTopics = Array.isArray(synthesis.interestTopics)
          ? synthesis.interestTopics.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : undefined;

        if (
          summary.kind === "no_new_data"
          && candidates.length === 0
          && hasConcretePersonalContext(normalizedInputs)
        ) {
          logDreamEvent(input, "summarizer_retry_started", {
            strategy: "subagent",
            reason: "no_new_data_with_personal_context",
          });
          const retrySynthesis = await runDreamingSummarizer(input.api, {
            locale: dreamingLanguage,
            trigger: input.run.trigger,
            startedAt: input.run.startedAt,
            windowStart: input.windowStart,
            windowEnd: input.windowEnd,
            currentProfile,
            sourceStats,
            rawInputs,
            normalizedInputs,
            mode: "deep_retry",
          });
          candidates = sanitizeDreamCandidates(retrySynthesis.candidateCards, nowIso);
          summary = normalizeDreamSummaryFromModel(retrySynthesis, {
            ...buildMinimalSummary(sourceStats, dreamingLanguage),
            candidateCount: candidates.length,
          });
          highlights = Array.isArray(summary.highlights)
            ? summary.highlights.filter((item): item is string => typeof item === "string")
            : fallbackHighlights;
          markdown = typeof retrySynthesis.journalMarkdown === "string" && retrySynthesis.journalMarkdown.trim().length > 0
            ? retrySynthesis.journalMarkdown.trim()
            : markdown;
          interestTopics = Array.isArray(retrySynthesis.interestTopics)
            ? retrySynthesis.interestTopics.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : interestTopics;
          logDreamEvent(input, "summarizer_retry_completed", {
            candidateCount: candidates.length,
            summaryKind: summary.kind,
          });
        }
        logDreamEvent(input, "summarizer_completed", {
          candidateCount: candidates.length,
          summaryKind: summary.kind,
        });
      } catch (error) {
        logDreamEvent(input, "summarizer_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const profileDelta = buildProfileDelta(
      currentProfile,
      sourceStats,
      summary,
      candidates,
      normalizedInputs,
      nowIso,
      input.windowStart,
      input.windowEnd,
      {
        highlights,
        interestTopics,
      },
    );

    const artifactDir = writeArtifacts(input.runDir, {
      meta: {
        runId: input.run.id,
        trigger: input.run.trigger,
        startedAt: input.run.startedAt,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        sourceIds: sources.map((source) => source.id),
        runLogPath: input.runLogPath,
        rootLogPath: input.rootLogPath,
      },
      rawInputs,
      normalizedInputs,
      summary,
      profileDelta,
      candidates,
    });
    markdown ??= buildMinimalDreamJournal({
      locale: dreamingLanguage,
      trigger: input.run.trigger,
      startedAt: input.run.startedAt,
      summary,
    });
    const dreamMarkdownPath = writeDreamMarkdown(root, artifactDir, markdown);
    logDreamEvent(input, "artifacts_written", { artifactDir });
    logDreamEvent(input, "markdown_written", {
      runMarkdownPath: dreamMarkdownPath,
      journalPath: join(getDreamsDir(root), DREAM_ROOT_MARKDOWN_FILE_NAME),
    });

    const completedRun = input.store.completeRun(input.run.id, {
      artifactDir,
      sourceStats,
      summary,
      profileDelta,
    });
    input.store.prune(MAX_STORED_DREAM_RUNS);
    logDreamEvent(input, "run_completed", {
      summaryKind: summary.kind,
      candidateCount: candidates.length,
    });

    return {
      run: completedRun,
      detail: {
        rawInputs,
        normalizedInputs,
        summary,
        dreamMarkdownPath,
        dreamMarkdown: markdown,
        profileDelta,
        candidates,
        sourceBreakdown,
        logPath: input.runLogPath,
        logText: readTextIfExists(input.runLogPath),
      },
    };
  } catch (error) {
    logDreamEvent(input, "run_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const failedRun = input.store.failRun(input.run.id, error instanceof Error ? error.message : String(error));
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { run: failedRun });
  }
}

export async function runDreaming(input: RunDreamingInput): Promise<{ run: DreamRunRecord; detail: DreamRunDetail }> {
  return await executeDreaming(createDreamExecutionContext(input));
}

export async function startDreaming(input: RunDreamingInput): Promise<DreamRunRecord> {
  const execution = createDreamExecutionContext(input);
  void executeDreaming(execution).catch(() => {
    // The run state is persisted as failed inside executeDreaming.
  });
  return execution.run;
}

export function listDreamRuns(ctx: CoreContext): DreamRunRecord[] {
  const root = resolveAppRootFromCtx(ctx);
  return new DreamRunStore(root).listRuns(MAX_STORED_DREAM_RUNS);
}

export function getDreamRun(ctx: CoreContext, runId: string): DreamRunRecord | null {
  const root = resolveAppRootFromCtx(ctx);
  return new DreamRunStore(root).getRun(runId);
}

export function getDreamRunDetail(ctx: CoreContext, runId: string): { run: DreamRunRecord; detail: DreamRunDetail } | null {
  const root = resolveAppRootFromCtx(ctx);
  const store = new DreamRunStore(root);
  const run = store.getRun(runId);
  if (!run) return null;
  const artifactDir = run.artifactDir ?? join(getDreamsDir(root), run.id);
  const logPath = join(artifactDir, DREAM_RUN_LOG_FILE_NAME);
  const dreamMarkdownPath = join(artifactDir, DREAM_RUN_MARKDOWN_FILE_NAME);
  const sourceStats = (run.sourceStatsJson ?? {}) as Record<string, { status?: DreamSourceStatus; count?: number; message?: string }>;
  const rawInputs = parseArtifactIfExists<Record<string, unknown>>(artifactDir, "inputs.raw.json", {});
  const sourceBreakdown = buildSourceBreakdownFromStored(sourceStats, rawInputs);
  const fallbackSummary: DreamSummary = run.status === "running"
    ? {
        kind: "running",
        text: "Dreaming is collecting inputs and writing logs.",
        sourceCount: 0,
        candidateCount: 0,
      }
    : run.status === "failed"
      ? {
          kind: "failed",
          text: run.errorMessage ?? "Dreaming failed before artifacts were completed.",
          sourceCount: 0,
          candidateCount: 0,
        }
      : {
          kind: "no_new_data",
          text: "Dreaming has not produced artifacts yet.",
          sourceCount: 0,
          candidateCount: 0,
        };

  return {
    run,
    detail: {
      rawInputs,
      normalizedInputs: parseArtifactIfExists<Record<string, unknown>>(artifactDir, "inputs.normalized.json", {}),
      summary: parseArtifactIfExists<DreamSummary>(artifactDir, "summary.json", fallbackSummary),
      dreamMarkdownPath: existsSync(dreamMarkdownPath) ? dreamMarkdownPath : null,
      dreamMarkdown: readTextIfExists(dreamMarkdownPath),
      profileDelta: parseArtifactIfExists<DreamProfileDelta>(artifactDir, "profile-delta.json", emptyProfileDelta()),
      candidates: parseArtifactIfExists<Array<Record<string, unknown>>>(artifactDir, "candidates.json", []),
      sourceBreakdown,
      logPath: existsSync(logPath) ? logPath : null,
      logText: readTextIfExists(logPath),
    },
  };
}

export async function applyDreamProfile(input: ApplyDreamProfileInput): Promise<DreamRunRecord> {
  const root = resolveAppRootFromCtx(input.ctx);
  const store = new DreamRunStore(root);
  const run = store.assertCanApply(input.runId);
  if (!run.profileDeltaJson) {
    throw new Error(`Dream run ${input.runId} has no profile delta`);
  }

  const repository = await createProfileRepository(input.ctx);
  const updated = await repository.update(DEFAULT_PROFILE_ID, {
    facts: run.profileDeltaJson.facts.after,
    preferences: run.profileDeltaJson.preferences.after,
    interests: run.profileDeltaJson.interests.after,
    snapshots: run.profileDeltaJson.snapshots.after,
  });
  if (!updated) {
    throw new Error("Default profile not found");
  }

  return store.markApplied(input.runId);
}
