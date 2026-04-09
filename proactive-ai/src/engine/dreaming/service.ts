import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "your", "about",
  "into", "after", "before", "were", "been", "also", "will", "just", "last",
  "recent", "review", "update", "todo", "page",
  "gmail", "googlecalendar", "calendar", "notion", "slack", "email", "event",
  "events", "message", "messages", "thread", "sync", "daily", "item", "items",
  "today", "tomorrow", "yesterday", "latest", "dreaming",
]);
const INTEREST_TEXT_KEYS = new Set([
  "title", "subject", "summary", "snippet", "preview", "text", "name", "reason",
  "key", "targetkey",
]);
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

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

function clampWindowStart(now: Date, latestCompletedAt: string | null): string {
  if (latestCompletedAt) return latestCompletedAt;
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

function normalizeKeyHint(value: string | null | undefined): string {
  return (value ?? "").replace(/[^a-z]/gi, "").toLowerCase();
}

function flattenTexts(value: unknown, acc: string[], keyHint?: string): void {
  if (typeof value === "string") {
    if (!keyHint || INTEREST_TEXT_KEYS.has(normalizeKeyHint(keyHint))) {
      acc.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenTexts(item, acc, keyHint);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) flattenTexts(item, acc, childKey);
  }
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function deriveInterests(normalizedInputs: Record<string, unknown>, fallbackTimestamp: string): Array<Record<string, unknown>> {
  const texts: string[] = [];
  flattenTexts(normalizedInputs, texts);
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([key, evidenceCount], index) => ({
      id: `dream_interest_${index}_${key}`,
      kind: "topic",
      key,
      score: Number(Math.min(0.95, 0.35 + evidenceCount * 0.15).toFixed(2)),
      confidence: Number(Math.min(0.95, 0.4 + evidenceCount * 0.1).toFixed(2)),
      evidenceCount,
      lastSignalAt: fallbackTimestamp,
      status: "active",
    }));
}

function titleCaseConnector(connector: string): string {
  if (connector === "googlecalendar") return "Google Calendar";
  return connector.charAt(0).toUpperCase() + connector.slice(1);
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

function inferBasketFromTitle(title: string, fallback: string): string {
  const normalized = title.toLowerCase();
  if (/(invoice|billing|receipt|budget|payment|expense|tax|renewal|subscription)/.test(normalized)) return "wealth";
  if (/(meeting|sync|review|launch|project|customer|demo|roadmap|github|product|standup)/.test(normalized)) return "work";
  if (/(workshop|webinar|course|learn|conference|funding|founder|community|growth)/.test(normalized)) return "growth";
  if (/(doctor|health|sleep|exercise|fitness|medication|therapy)/.test(normalized)) return "health";
  if (/(family|home|parent|kid|travel|trip|friend)/.test(normalized)) return "family";
  return fallback;
}

function extractHighlights(normalizedInputs: Record<string, unknown>): string[] {
  const highlights: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!highlights.includes(trimmed)) highlights.push(trimmed);
  };

  const personalEntries = Array.isArray(normalizedInputs.personal)
    ? normalizedInputs.personal as Array<Record<string, unknown>>
    : [];
  for (const entry of personalEntries) {
    push(entry.title);
  }

  const feedbackEntries = Array.isArray(normalizedInputs.feedback)
    ? normalizedInputs.feedback as Array<Record<string, unknown>>
    : [];
  for (const entry of feedbackEntries) {
    if (typeof entry.action === "string" && typeof entry.basket === "string") {
      push(`${entry.action} in ${entry.basket}`);
    }
  }

  const signalEntries = Array.isArray(normalizedInputs.signals)
    ? normalizedInputs.signals as Array<Record<string, unknown>>
    : [];
  for (const entry of signalEntries) {
    push(entry.targetKey ?? entry.key);
  }

  return highlights.slice(0, 5);
}

function deriveTopBasket(rawInputs: Record<string, unknown>): string {
  const counts = new Map<string, number>();
  const pushBasket = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  };

  const scan = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === "basket" || key === "goalBasket") pushBasket(item);
        scan(item);
      }
    }
  };
  scan(rawInputs);

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "life";
}

function buildCandidates(
  rawInputs: Record<string, unknown>,
  normalizedInputs: Record<string, unknown>,
  nowIso: string,
): Array<Record<string, unknown>> {
  const topBasket = deriveTopBasket(rawInputs);
  const personalEntries = Array.isArray(normalizedInputs.personal)
    ? normalizedInputs.personal as Array<Record<string, unknown>>
    : [];

  const candidates = personalEntries.slice(0, 3).map((entry, index) => {
    const connector = String(entry.connector ?? "personal");
    const title = String(entry.title ?? `${titleCaseConnector(connector)} update`);
    const basket = inferBasketFromTitle(title, topBasket);
    let candidateTitle = `Revisit ${title}`;
    let reason = `Recent ${titleCaseConnector(connector)} activity surfaced during the latest dreaming window.`;

    if (connector === "gmail") {
      candidateTitle = `Check email: ${title}`;
      reason = "A recent email looks specific enough to review or act on.";
    } else if (connector === "googlecalendar") {
      candidateTitle = `Prepare for ${title}`;
      reason = "An upcoming calendar item was detected in the latest dreaming window.";
    } else if (connector === "notion") {
      candidateTitle = `Follow up in Notion: ${title}`;
      reason = "A recently updated Notion item may need a next step.";
    } else if (connector === "slack") {
      candidateTitle = `Review Slack context: ${title}`;
      reason = "A recent Slack thread looks relevant for follow-up.";
    }

    return {
      id: `dream_candidate_${index + 1}`,
      title: candidateTitle,
      basket,
      reason,
      connector,
      source: "dreaming",
      createdAt: nowIso,
    };
  });

  if (candidates.length === 0) {
    const highlights = extractHighlights(normalizedInputs);
    if (highlights[0]) {
      candidates.push({
        id: "dream_candidate_summary",
        title: `Revisit ${highlights[0]}`,
        basket: inferBasketFromTitle(highlights[0], topBasket),
        reason: "Dreaming found a recent highlight worth revisiting.",
        connector: "dreaming",
        source: "dreaming",
        createdAt: nowIso,
      });
    }
  }

  return candidates.slice(0, 3);
}

function buildSummary(
  sourceStats: Record<string, Record<string, unknown>>,
  candidates: Array<Record<string, unknown>>,
  highlights: string[],
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
  const highlightText = highlights.slice(0, 2).join("; ");
  return {
    kind: "updated",
    text: isZh
      ? `这次 dreaming 回看了 ${totalCount} 条近期内容，来自 ${activeSources} 个活跃来源${sourceList ? `（${sourceList}）` : ""}，并整理出 ${candidates.length} 张候选卡片。${highlightText ? `重点线索包括：${highlightText}。` : ""}`
      : `Dreaming reviewed ${totalCount} recent items across ${activeSources} active sources${sourceList ? ` (${sourceList})` : ""} and produced ${candidates.length} candidate cards.${highlightText ? ` Key highlights: ${highlightText}.` : ""}`,
    sourceCount: activeSources,
    candidateCount: candidates.length,
    highlights,
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
): DreamProfileDelta {
  const currentFacts = (currentProfile.facts ?? {}) as Record<string, unknown>;
  const currentPreferences = (currentProfile.preferences ?? {}) as Record<string, unknown>;
  const currentInterests = ((currentProfile.interests ?? []) as Array<Record<string, unknown>>);
  const currentSnapshots = ((currentProfile.snapshots ?? []) as Array<Record<string, unknown>>);
  const topBasket = deriveTopBasket(normalizedInputs);
  const highlights = extractHighlights(normalizedInputs);

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
      topBasket,
      lastUpdatedAt: nowIso,
    },
  };

  const derivedInterests = deriveInterests(normalizedInputs, nowIso);
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

function buildDreamJournal(input: {
  locale: unknown;
  summary: DreamSummary;
  highlights: string[];
  candidates: Array<Record<string, unknown>>;
  trigger: "auto" | "manual";
  startedAt: string;
}): string {
  const highlights = input.highlights.slice(0, 2);
  const candidates = input.candidates.slice(0, 2);
  const isZh = isChineseLocale(input.locale);
  const runLabel = `${input.startedAt.slice(0, 10)} · ${input.trigger}`;

  if (isZh) {
    const firstParagraph = highlights.length > 0
      ? `昨天我注意到你最近反复浮现的线索里，最明显的是 ${highlights.map((item) => `「${item}」`).join(" 和 ")}。我把这些个人信息流、近期卡片和其他上下文放在一起重新想了一遍，觉得它们值得先替你记下来。`
      : "昨天我重新看了一遍你最近的个人信息流、卡片和反馈，但还没有看到特别明确的新线索。";
    const secondParagraph = candidates.length > 0
      ? `现在我更倾向于把重点放在 ${candidates.map((candidate) => `「${String(candidate.title ?? "")}」`).join(" 和 ")}。这些事情看起来更像是短期内值得你留意、也适合我后续继续帮你跟进的方向。`
      : "这次我还没有整理出足够明确的后续候选卡片，所以先把现有信号记下来，等下一次 dreaming 再继续观察。";

    return [
      "# Dreaming Journal",
      "",
      `## ${runLabel}`,
      "",
      firstParagraph,
      "",
      secondParagraph,
      "",
      `我想先替你记下这些变化。${typeof input.summary.text === "string" ? `这次 dreaming 的整体判断是：${input.summary.text}` : ""}`,
      "",
    ].join("\n");
  }

  const firstParagraph = highlights.length > 0
    ? `Yesterday I noticed that the clearest threads in your recent activity were ${highlights.map((item) => `"${item}"`).join(" and ")}. I looked back across your personal feed, recent cards, and the rest of the context, and these are the signals that felt worth keeping.`
    : "Yesterday I looked back across your recent personal feed, cards, and feedback, but I did not find a strong new pattern yet.";
  const secondParagraph = candidates.length > 0
    ? `Right now the follow-ups that feel most worth keeping in view are ${candidates.map((candidate) => `"${String(candidate.title ?? "")}"`).join(" and ")}. These look like the best short-term directions for me to keep tracking on your behalf.`
    : "I did not extract a strong next-step candidate this time, so I am only keeping the current signals in memory for the next dreaming pass.";

  return [
    "# Dreaming Journal",
    "",
    `## ${runLabel}`,
    "",
    firstParagraph,
    "",
    secondParagraph,
    "",
    `I want to keep these changes in mind for you. ${typeof input.summary.text === "string" ? `My overall read this time is: ${input.summary.text}` : ""}`,
    "",
  ].join("\n");
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

  const tryExecute = async (tool: string, args: Record<string, unknown>) => {
    const result = await provider.executeTool(tool, args);
    return result.success ? result.data : null;
  };

  for (const connection of active) {
    try {
      if (connection.toolkit === "gmail") {
        const data = await tryExecute("GMAIL_FETCH_EMAILS", {});
        connectors.gmail = data ?? [];
        const items = Array.isArray((data as { messages?: unknown[] } | null)?.messages)
          ? ((data as { messages?: Array<Record<string, unknown>> }).messages ?? [])
          : Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
        normalized.push(...items.slice(0, 10).map((item) => ({
          connector: "gmail",
          title: item.subject ?? item.snippet ?? "Recent email",
          timestamp: item.internalDate ?? item.messageTimestamp ?? item.date ?? windowEnd,
        })));
        continue;
      }

      if (connection.toolkit === "googlecalendar") {
        const data = await tryExecute("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", {
          time_min: windowStart,
          time_max: windowEnd,
        });
        connectors.googlecalendar = data ?? [];
        const summaryView = typeof (data as { summary_view?: unknown } | null)?.summary_view === "string"
          ? String((data as { summary_view: string }).summary_view)
          : null;
        const items = Array.isArray((data as { items?: unknown[] } | null)?.items)
          ? ((data as { items?: Array<Record<string, unknown>> }).items ?? [])
          : Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
        if (summaryView && items.length === 0) {
          normalized.push(...normalizeGoogleCalendarSummaryView(summaryView, windowEnd));
        } else {
          normalized.push(...items.slice(0, 10).map((item) => ({
            connector: "googlecalendar",
            title: item.title ?? item.summary ?? "Calendar event",
            timestamp: item.start ?? item.updated ?? windowEnd,
          })));
        }
        continue;
      }

      if (connection.toolkit === "notion") {
        const data = await tryExecute("NOTION_FETCH_DATA", {});
        connectors.notion = data ?? [];
        const items = Array.isArray((data as { items?: unknown[] } | null)?.items)
          ? ((data as { items?: Array<Record<string, unknown>> }).items ?? [])
          : Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
        normalized.push(...items.slice(0, 10).map((item) => ({
          connector: "notion",
          title: item.title ?? item.name ?? "Notion item",
          timestamp: item.last_edited_time ?? item.updated_at ?? windowEnd,
        })));
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

function createDreamExecutionContext(input: RunDreamingInput): DreamExecutionContext {
  const root = resolveAppRootFromCtx(input.ctx);
  ensureDir(getDreamsDir(root));
  ensureDir(getDreamsLogsDir(root));
  const store = new DreamRunStore(root);
  const now = input.now ?? new Date();
  const windowEnd = now.toISOString();
  const latestSuccess = store.getLatestSuccessfulRun();
  const windowStart = clampWindowStart(now, latestSuccess?.completedAt ?? null);
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
    const highlights = extractHighlights(normalizedInputs);
    const candidates = buildCandidates(rawInputs, normalizedInputs, nowIso);
    const summary = buildSummary(sourceStats, candidates, highlights, dreamingLanguage);
    const profileDelta = buildProfileDelta(
      currentProfile,
      sourceStats,
      summary,
      candidates,
      normalizedInputs,
      nowIso,
      input.windowStart,
      input.windowEnd,
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
    const markdown = buildDreamJournal({
      locale: dreamingLanguage,
      trigger: input.run.trigger,
      startedAt: input.run.startedAt,
      summary,
      candidates,
      highlights,
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
