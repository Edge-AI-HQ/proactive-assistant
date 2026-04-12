import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  type CoreContext,
  PinDatabaseManager,
  ProfileRepository,
  MemoryRepository,
  createPersonalProvider,
  type PersonalProvider,
  type PersonalToolInfo,
  type PersonalToolSchema,
  feedback,
  memory,
  profile,
  appPaths,
  resolveAppRootFromCtx,
} from "../../core/index.js";
import { detectAgentErrorInMessages, parseAgentJson } from "../pipeline/agent-output.js";
import { loadRunStore } from "../pipeline/run-store.js";
import { DreamRunStore, type DreamGoalDelta, type DreamGoalDeltaChange, type DreamProfileDelta, type DreamRunRecord, type DreamSummary } from "./store.js";

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
  goalDelta: DreamGoalDelta;
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
const PERSONAL_PROVIDER_TIMEOUT_MS = 12_000;
const PERSONAL_TOOL_SEARCH_LIMIT = 100;
const PERSONAL_MAX_TOOL_CANDIDATES = 8;
const PERSONAL_MAX_TOOL_RUNS = 4;
const PERSONAL_MAX_TOOL_ATTEMPTS = 10;
const PERSONAL_MAX_NORMALIZED_ITEMS = 200;
const PERSONAL_TOOL_DISCOVERY_SUFFIXES = [
  "emails",
  "events",
  "messages",
  "notifications",
  "issues",
  "pull requests",
  "pages",
  "files",
  "channels",
];
const PERSONAL_READ_KEYWORDS = [
  "search",
  "fetch",
  "list",
  "get",
  "history",
  "read",
  "recent",
  "message",
  "email",
  "event",
  "issue",
  "notification",
  "thread",
  "conversation",
  "page",
  "file",
  "note",
  "document",
  "activity",
];
const PERSONAL_WRITE_KEYWORDS = [
  "create",
  "update",
  "delete",
  "remove",
  "send",
  "post",
  "reply",
  "upload",
  "insert",
  "append",
  "publish",
  "disconnect",
  "connect",
  "write",
];
const DYNAMIC_TITLE_PATHS = [
  "subject",
  "title",
  "name",
  "summary",
  "preview.subject",
  "page_title",
  "thread_title",
  "channel",
  "calendar",
];
const DYNAMIC_PREVIEW_PATHS = [
  "preview.body",
  "snippet",
  "description",
  "summary",
  "text",
  "body",
  "messageText",
  "content",
  "excerpt",
];
const DYNAMIC_BODY_PATHS = [
  "messageText",
  "body",
  "content",
  "text",
  "description",
  "preview.body",
];
const DYNAMIC_ACTOR_PATHS = [
  "sender",
  "from",
  "author.name",
  "author.login",
  "user.name",
  "user.login",
  "creator.name",
  "creator.login",
  "assignee.login",
];
const DYNAMIC_TIMESTAMP_PATHS = [
  "messageTimestamp",
  "internalDate",
  "updated_at",
  "updatedAt",
  "last_edited_time",
  "created_time",
  "createdAt",
  "start",
  "start.dateTime",
  "start.date",
  "ts",
  "date",
  "time",
  "occurredAt",
];
const DYNAMIC_URL_PATHS = [
  "display_url",
  "html_url",
  "url",
  "permalink",
  "link",
];

interface DynamicPersonalToolCandidate {
  slug: string;
  description: string | null;
  schema: PersonalToolSchema | null;
  score: number;
}

interface ExecutedPersonalToolRun {
  slug: string;
  description: string | null;
  args: Record<string, unknown>;
  itemCount: number;
  payload: unknown;
}

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
  goalDelta?: unknown;
}

interface DreamingSummarizerInput {
  locale: unknown;
  trigger: "auto" | "manual";
  startedAt: string;
  windowStart: string;
  windowEnd: string;
  currentProfile: Record<string, unknown>;
  sourceStats: Record<string, Record<string, unknown>>;
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  mode: "primary" | "deep_retry" | "json_retry";
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

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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

async function createMemoryRepository(ctx: CoreContext): Promise<MemoryRepository> {
  const root = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(root);
  await manager.init();
  return new MemoryRepository(manager.open("pin"));
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

function emptyGoalDelta(): DreamGoalDelta {
  return { changes: [] };
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
  const record = value as Record<string, unknown>;
  if (typeof record.itemCount === "number" && Number.isFinite(record.itemCount)) return record.itemCount;
  if (Array.isArray(record.messages)) return arrayOfObjects(record.messages).length;
  if (Array.isArray(record.summary_view)) return record.summary_view.length;
  if (typeof record.summary_view === "string") {
    return record.summary_view.split("\n").filter((line) => line.trim().length > 0).length;
  }
  if (Array.isArray(record.events) && record.events.length > 0) return record.events.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.results)) return record.results.length;
  let count = 0;
  for (const entry of Object.values(record)) {
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

function unwrapComposioDataPreview(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.data_preview && typeof record.data_preview === "object" && !Array.isArray(record.data_preview)) {
    return record.data_preview;
  }
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return unwrapComposioDataPreview(record.data);
  }
  return value;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function slugifySubjectKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "dreaming";
}

function buildDreamMemoryEvents(run: DreamRunRecord): Array<{
  profileId: string;
  source: string;
  kind: string;
  subjectType: string;
  subjectKey: string;
  text: string;
  payload: Record<string, unknown>;
  confidence: number;
  occurredAt?: string;
}> {
  const occurredAt = run.completedAt ?? new Date().toISOString();
  const events: Array<{
    profileId: string;
    source: string;
    kind: string;
    subjectType: string;
    subjectKey: string;
    text: string;
    payload: Record<string, unknown>;
    confidence: number;
    occurredAt?: string;
  }> = [];
  const seen = new Set<string>();
  const highlights = normalizeStringArray(run.summaryJson?.highlights);

  const pushEvent = (event: {
    profileId: string;
    source: string;
    kind: string;
    subjectType: string;
    subjectKey: string;
    text: string;
    payload: Record<string, unknown>;
    confidence: number;
    occurredAt?: string;
  }) => {
    const key = `${event.subjectType}|${event.subjectKey}|${event.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  const summaryText = compactText(run.summaryJson?.text);
  if (summaryText) {
    pushEvent({
      profileId: DEFAULT_PROFILE_ID,
      source: "dreaming",
      kind: "profile_refined",
      subjectType: "dreaming",
      subjectKey: "summary",
      text: summaryText,
      payload: {
        runId: run.id,
        trigger: run.trigger,
        highlights,
      },
      confidence: 0.72,
      occurredAt,
    });
  }

  for (const highlight of highlights) {
    pushEvent({
      profileId: DEFAULT_PROFILE_ID,
      source: "dreaming",
      kind: "highlight_captured",
      subjectType: "dreaming",
      subjectKey: `highlight:${slugifySubjectKey(highlight)}`,
      text: highlight,
      payload: {
        runId: run.id,
        trigger: run.trigger,
      },
      confidence: 0.78,
      occurredAt,
    });
  }

  const beforeInterestKeys = new Set(
    arrayOfObjects(run.profileDeltaJson?.interests.before)
      .map((interest) => compactText(interest.key))
      .filter((value): value is string => !!value),
  );
  const nextInterests = arrayOfObjects(run.profileDeltaJson?.interests.after);
  for (const interest of nextInterests) {
    const interestKey = compactText(interest.key);
    if (!interestKey || beforeInterestKeys.has(interestKey)) {
      continue;
    }
    pushEvent({
      profileId: DEFAULT_PROFILE_ID,
      source: "dreaming",
      kind: "interest_detected",
      subjectType: "interest",
      subjectKey: interestKey,
      text: `Dreaming surfaced a recurring interest in ${interestKey}.`,
      payload: {
        runId: run.id,
        interest,
      },
      confidence: typeof interest.score === "number" ? Number(interest.score) : 0.7,
      occurredAt,
    });
  }

  return events;
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

function sanitizeGoalKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : `dream-goal-${Date.now().toString(36)}`;
}

function normalizeGoalPatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = compactText(record.title);
  const priority = compactText(record.priority);
  const summary = compactText(record.summary);
  const status = compactText(record.status);
  const patch: Record<string, unknown> = {};
  if (title) patch.title = title;
  if (priority) patch.priority = priority;
  if (summary) patch.summary = summary;
  if (status) patch.status = status;
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeGoalDelta(goalDelta: unknown): DreamGoalDelta {
  if (!goalDelta || typeof goalDelta !== "object" || Array.isArray(goalDelta)) return emptyGoalDelta();
  const changes = Array.isArray((goalDelta as { changes?: unknown[] }).changes)
    ? (goalDelta as { changes: unknown[] }).changes
    : [];
  const normalized = changes
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const action = compactText(item.action);
      if (action !== "create" && action !== "update" && action !== "close") return null;
      const before = item.before && typeof item.before === "object" && !Array.isArray(item.before)
        ? item.before as Record<string, unknown>
        : null;
      const after = normalizeGoalPatch(item.after);
      const rawKey = compactText(item.key) ?? compactText(after?.title) ?? compactText(before?.key);
      if (!rawKey) return null;
      return {
        action,
        key: sanitizeGoalKey(rawKey),
        reason: compactText(item.reason) ?? "Dreaming suggested this goal change.",
        before,
        after: action === "close" ? null : (after ?? null),
      } satisfies DreamGoalDeltaChange;
    })
    .filter((item): item is DreamGoalDeltaChange => item !== null);
  return { changes: normalized };
}

function parseIso(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseLooseTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+\.\d+$/.test(trimmed)) {
    const parsed = new Date(Number(trimmed.split(".")[0]) * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{9,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const millis = trimmed.length >= 12 ? numeric : numeric * 1000;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return parseIso(trimmed);
}

function readObjectPath(value: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function pickTextByPaths(record: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = readObjectPath(record, path);
    const text = compactText(value);
    if (text) return text;
  }
  return null;
}

function toIsoDateString(value: string): string | null {
  const parsed = parseIso(value);
  if (!parsed) return null;
  return `${parsed.getUTCFullYear()}-${formatReadableDatePart(parsed.getUTCMonth() + 1)}-${formatReadableDatePart(parsed.getUTCDate())}`;
}

function toSlashDateString(value: string): string | null {
  const parsed = parseIso(value);
  if (!parsed) return null;
  return `${parsed.getUTCFullYear()}/${formatReadableDatePart(parsed.getUTCMonth() + 1)}/${formatReadableDatePart(parsed.getUTCDate())}`;
}

function buildGenericQueryVariants(windowStart: string, windowEnd: string): string[] {
  const startIsoDate = toIsoDateString(windowStart);
  const endIsoDate = toIsoDateString(windowEnd);
  const startSlashDate = toSlashDateString(windowStart);
  const endSlashDate = toSlashDateString(windowEnd);
  const variants = [
    startIsoDate && endIsoDate ? `after:${startIsoDate} before:${endIsoDate}` : null,
    startSlashDate && endSlashDate ? `after:${startSlashDate} before:${endSlashDate}` : null,
    startIsoDate ? `updated:>=${startIsoDate}` : null,
    `modifiedTime > '${windowStart}' and modifiedTime < '${windowEnd}'`,
    startIsoDate ? `since ${startIsoDate}` : null,
  ];
  return variants.filter((value): value is string => !!value);
}

function humanizeToolkitForQuery(toolkit: string): string {
  return toolkit
    .replace(/googlecalendar/gi, "google calendar")
    .replace(/googledrive/gi, "google drive")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function buildToolkitDiscoveryQueries(toolkit: string): string[] {
  const humanizedToolkit = humanizeToolkitForQuery(toolkit);
  const rawQueries = [
    humanizedToolkit,
    ...PERSONAL_TOOL_DISCOVERY_SUFFIXES.map((suffix) => `${humanizedToolkit} ${suffix}`),
  ];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const query of rawQueries.map((value) => value.trim()).filter((value) => value.length > 0)) {
    const normalized = query.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(query);
  }
  return deduped.slice(0, 5);
}

function buildDefaultScalarForSchemaProperty(
  key: string,
  property: Record<string, unknown>,
  windowStart: string,
  windowEnd: string,
): unknown {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "since") return windowStart;
  if (normalizedKey === "time_min" || normalizedKey === "start_time" || normalizedKey === "date_from") return windowStart;
  if (normalizedKey === "time_max" || normalizedKey === "end_time" || normalizedKey === "date_to") return windowEnd;
  if (normalizedKey === "after") return Math.floor(new Date(windowStart).getTime() / 1000).toString();
  if (normalizedKey === "before") return Math.floor(new Date(windowEnd).getTime() / 1000).toString();
  if (normalizedKey === "oldest") return Math.floor(new Date(windowStart).getTime() / 1000).toString();
  if (normalizedKey === "latest") return Math.floor(new Date(windowEnd).getTime() / 1000).toString();
  if (normalizedKey === "limit" || normalizedKey === "count" || normalizedKey === "page_size" || normalizedKey === "per_page" || normalizedKey === "max_results") return 100;
  if (normalizedKey === "state" || normalizedKey === "filter") return "all";
  if (normalizedKey === "sort") return "timestamp";
  if (normalizedKey === "sort_dir" || normalizedKey === "order" || normalizedKey === "direction") return "desc";
  if (normalizedKey === "summary_only") return false;
  if (normalizedKey === "single_events") return true;
  if (normalizedKey === "include_context") return true;
  if (normalizedKey === "include_archived") return false;
  if (normalizedKey === "include_bots") return false;
  if (normalizedKey === "fetch_type") return "all";
  if (normalizedKey === "spaces") return "drive";
  if (normalizedKey === "corpora") return "user";
  if (normalizedKey === "response_format") return "detailed";
  if (normalizedKey === "content_types") return "messages";

  const enumValues = Array.isArray(property.enum) ? property.enum.filter((item): item is string => typeof item === "string") : [];
  if (enumValues.includes("all")) return "all";
  if (enumValues.includes("timestamp")) return "timestamp";
  if (enumValues.includes("desc")) return "desc";
  if (enumValues.includes("detailed")) return "detailed";
  if (enumValues.length === 1) return enumValues[0];
  return undefined;
}

function filterArgumentVariantBySchema(
  propertyBag: Record<string, Record<string, unknown>>,
  required: string[],
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const filtered = Object.fromEntries(
    Object.entries(args).filter(([key, value]) => key in propertyBag && value !== undefined),
  );
  if (required.some((key) => !(key in filtered))) return null;
  return filtered;
}

function buildConnectorSpecificArgumentVariants(
  toolkit: string,
  slug: string,
  propertyBag: Record<string, Record<string, unknown>>,
  required: string[],
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const normalizedToolkit = toolkit.toLowerCase();
  const normalizedSlug = slug.toLowerCase();
  const startIsoDate = toIsoDateString(windowStart);
  const endIsoDate = toIsoDateString(windowEnd);
  const queryWindow = [
    startIsoDate ? `after:${startIsoDate}` : null,
    endIsoDate ? `before:${endIsoDate}` : null,
  ].filter((value): value is string => !!value).join(" ");

  const variants: Array<Record<string, unknown>> = [];
  if (normalizedToolkit === "gmail" && normalizedSlug.includes("fetch") && normalizedSlug.includes("email")) {
    variants.push({
      query: queryWindow || undefined,
      max_results: 100,
      include_payload: true,
      verbose: true,
    });
  }

  if (normalizedToolkit === "googlecalendar" && normalizedSlug.includes("events_list_all_calendars")) {
    variants.push({
      time_min: windowStart,
      time_max: windowEnd,
      single_events: true,
      summary_only: false,
      max_results: 100,
    });
  }

  if (normalizedToolkit === "slack" && (normalizedSlug.includes("search_all") || normalizedSlug.includes("search_messages"))) {
    variants.push({
      query: queryWindow || `after:${toIsoDateString(windowStart) ?? ""}`.trim(),
      count: 100,
      sort: "timestamp",
      sort_dir: "desc",
      include_bots: false,
      include_context: true,
    });
  }

  if (normalizedToolkit === "github" && normalizedSlug.includes("issues_assigned_to_the_authenticated_user")) {
    variants.push({
      since: windowStart,
      state: "all",
      filter: "assigned",
      per_page: 100,
      direction: "desc",
    });
  }

  if (normalizedToolkit === "googledrive" && normalizedSlug.includes("find_file")) {
    variants.push({
      q: `modifiedTime > '${windowStart}' and modifiedTime < '${windowEnd}'`,
      page_size: 100,
      spaces: "drive",
      corpora: "user",
    });
  }

  if (normalizedToolkit === "notion" && normalizedSlug.includes("fetch_data")) {
    variants.push({
      fetch_type: "get_all",
      page_size: 100,
      query: queryWindow || undefined,
    });
  }

  const filtered = variants
    .map((args) => filterArgumentVariantBySchema(propertyBag, required, args))
    .filter((args): args is Record<string, unknown> => !!args);
  return filtered.filter((args, index, list) =>
    list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(args)) === index,
  );
}

function buildToolArgumentVariants(
  toolkit: string,
  slug: string,
  schema: PersonalToolSchema | null,
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const parameters = schema?.parameters && typeof schema.parameters === "object" && !Array.isArray(schema.parameters)
    ? schema.parameters as Record<string, unknown>
    : {};
  const propertyBag = parameters.type === "object" && parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, Record<string, unknown>>
    : parameters as Record<string, Record<string, unknown>>;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((item): item is string => typeof item === "string")
    : [];
  const connectorSpecific = buildConnectorSpecificArgumentVariants(
    toolkit,
    slug,
    propertyBag,
    required,
    windowStart,
    windowEnd,
  );
  if (connectorSpecific.length > 0) {
    return connectorSpecific;
  }
  const queryKeys = Object.keys(propertyBag).filter((key) => {
    const normalized = key.toLowerCase();
    return normalized === "query" || normalized === "q" || normalized === "search_query";
  });
  const baseArgs: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(propertyBag)) {
    if (queryKeys.includes(key)) continue;
    const value = buildDefaultScalarForSchemaProperty(key, property, windowStart, windowEnd);
    if (value !== undefined) baseArgs[key] = value;
  }

  const queryVariants = queryKeys.length > 0 ? buildGenericQueryVariants(windowStart, windowEnd) : [null];
  const variants = queryVariants.map((queryValue) => {
    const args = { ...baseArgs };
    if (queryValue !== null) {
      for (const key of queryKeys) {
        args[key] = queryValue;
      }
    }
    return args;
  });

  return variants.filter((args, index, list) => {
    const missingRequired = required.filter((key) => !(key in args));
    if (missingRequired.length > 0) return false;
    return list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(args)) === index;
  });
}

function rankDynamicPersonalToolCandidate(toolkit: string, tool: PersonalToolInfo, schema: PersonalToolSchema | null): number {
  const text = `${tool.slug} ${tool.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const keyword of PERSONAL_READ_KEYWORDS) {
    if (text.includes(keyword)) score += 3;
  }
  for (const keyword of PERSONAL_WRITE_KEYWORDS) {
    if (text.includes(keyword)) score -= 5;
  }
  const parameters = schema?.parameters && typeof schema.parameters === "object" && !Array.isArray(schema.parameters)
    ? schema.parameters as Record<string, unknown>
    : {};
  const required = Array.isArray(parameters.required) ? parameters.required.filter((item): item is string => typeof item === "string") : [];
  if (required.includes("owner") || required.includes("repo") || required.includes("channel")) score -= 6;
  if (required.length <= 2) score += 2;
  if (toolkit === "gmail") {
    if (text.includes("fetch") && text.includes("email")) score += 18;
    if (text.includes("profile")) score -= 12;
  }
  if (toolkit === "googlecalendar") {
    if (text.includes("events_list_all_calendars") || (text.includes("list") && text.includes("calendar"))) score += 18;
    if (text.includes("find_event")) score -= 10;
  }
  if (toolkit === "slack") {
    if (text.includes("search_all") || text.includes("search messages")) score += 18;
    if (text.includes("find_channels")) score -= 12;
  }
  if (toolkit === "github") {
    if (text.includes("issues_assigned_to_the_authenticated_user")) score += 20;
    if (text.includes("docker") || text.includes("migration conflict") || text.includes("conflict packages")) score -= 18;
  }
  if (toolkit === "googledrive") {
    if (text.includes("find_file") || text.includes("list file")) score += 8;
    if (text.includes("list_changes")) score -= 10;
  }
  if (toolkit === "notion") {
    if (text.includes("search") || text.includes("fetch_data")) score += 6;
  }
  return score;
}

async function discoverDynamicPersonalToolCandidates(
  provider: PersonalProvider,
  toolkit: string,
): Promise<DynamicPersonalToolCandidate[]> {
  const discovered = new Map<string, PersonalToolInfo>();
  for (const query of buildToolkitDiscoveryQueries(toolkit)) {
    const tools = await withTimeout(
      `searchTools(${toolkit}:${query})`,
      provider.searchTools(query, {
        toolkit,
        limit: PERSONAL_TOOL_SEARCH_LIMIT,
      }),
      PERSONAL_PROVIDER_TIMEOUT_MS,
    );
    for (const tool of tools) {
      if (!discovered.has(tool.slug)) {
        discovered.set(tool.slug, tool);
      }
    }
  }

  const candidates: DynamicPersonalToolCandidate[] = [];
  for (const tool of discovered.values()) {
    const schema = await withTimeout(
      `getToolSchema(${tool.slug})`,
      provider.getToolSchema(tool.slug),
      PERSONAL_PROVIDER_TIMEOUT_MS,
    ).catch(() => null);
    const score = rankDynamicPersonalToolCandidate(toolkit, tool, schema);
    if (score <= 0) continue;
    candidates.push({
      slug: tool.slug,
      description: tool.description,
      schema,
      score,
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, PERSONAL_MAX_TOOL_CANDIDATES);
}

function collectDynamicCandidateObjects(value: unknown, output: Array<Record<string, unknown>>, depth = 0): void {
  if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS || depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDynamicCandidateObjects(item, output, depth + 1);
      if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS) return;
    }
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasContentLikeField = keys.some((key) => {
    const normalized = key.toLowerCase();
    return normalized.includes("subject")
      || normalized.includes("title")
      || normalized.includes("text")
      || normalized.includes("body")
      || normalized.includes("summary")
      || normalized.includes("message")
      || normalized.includes("description")
      || normalized.includes("snippet")
      || normalized.includes("content")
      || normalized.includes("name");
  });
  if (hasContentLikeField) {
    output.push(record);
  }
  for (const child of Object.values(record)) {
    collectDynamicCandidateObjects(child, output, depth + 1);
    if (output.length >= PERSONAL_MAX_NORMALIZED_ITEMS) return;
  }
}

function isTimestampInWindow(timestamp: Date | null, windowStart: string, windowEnd: string): boolean {
  if (!timestamp) return true;
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  if (start && timestamp < start) return false;
  if (end && timestamp > end) return false;
  return true;
}

function normalizeDynamicPersonalRecord(
  toolkit: string,
  slug: string,
  record: Record<string, unknown>,
  windowStart: string,
  windowEnd: string,
): Record<string, unknown> | null {
  const timestampValue = DYNAMIC_TIMESTAMP_PATHS.map((path) => readObjectPath(record, path)).find((value) => value != null);
  const timestamp = parseLooseTimestamp(timestampValue);
  if (!isTimestampInWindow(timestamp, windowStart, windowEnd)) return null;

  const title = pickTextByPaths(record, DYNAMIC_TITLE_PATHS)
    ?? truncateText(pickTextByPaths(record, DYNAMIC_PREVIEW_PATHS), 120)
    ?? null;
  const preview = truncateText(pickTextByPaths(record, DYNAMIC_PREVIEW_PATHS), 600);
  const body = truncateText(pickTextByPaths(record, DYNAMIC_BODY_PATHS), 1600);
  const actor = pickTextByPaths(record, DYNAMIC_ACTOR_PATHS);
  const url = pickTextByPaths(record, DYNAMIC_URL_PATHS);
  const context = joinContextParts([
    title,
    actor,
    preview,
    body,
    compactText(record.channel),
    compactText(record.calendar),
  ]);

  if (!title && !preview && !body && !context) return null;

  return {
    connector: toolkit,
    tool: slug,
    title: title ?? `${toolkit} item`,
    timestamp: timestamp?.toISOString() ?? compactText(timestampValue) ?? windowEnd,
    actor,
    preview,
    body,
    url,
    context,
  };
}

function normalizeDynamicPersonalData(
  toolkit: string,
  toolRuns: ExecutedPersonalToolRun[],
  windowStart: string,
  windowEnd: string,
): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = [];

  for (const toolRun of toolRuns) {
    const unwrapped = unwrapComposioDataPreview(toolRun.payload);
    const summaryView = unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
      ? (unwrapped as Record<string, unknown>).summary_view
      : null;
    if (typeof summaryView === "string") {
      const lines = summaryView
        .split("\n")
        .map((line) => compactText(line))
        .filter((line): line is string => !!line)
        .slice(0, PERSONAL_MAX_NORMALIZED_ITEMS);
      for (const line of lines) {
        normalized.push({
          connector: toolkit,
          tool: toolRun.slug,
          title: line.replace(/^\d+[\.\)]\s*/, ""),
          timestamp: windowEnd,
          context: line,
        });
      }
      continue;
    }

    const candidates: Array<Record<string, unknown>> = [];
    collectDynamicCandidateObjects(unwrapped, candidates);
    for (const candidate of candidates) {
      const entry = normalizeDynamicPersonalRecord(toolkit, toolRun.slug, candidate, windowStart, windowEnd);
      if (entry) normalized.push(entry);
      if (normalized.length >= PERSONAL_MAX_NORMALIZED_ITEMS) break;
    }
    if (normalized.length >= PERSONAL_MAX_NORMALIZED_ITEMS) break;
  }

  const deduped: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const entry of normalized) {
    const signature = JSON.stringify([
      entry.connector,
      entry.tool,
      entry.title,
      entry.timestamp,
      entry.url,
      entry.preview,
    ]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(entry);
  }

  return deduped
    .sort((left, right) => {
      const leftTime = typeof left.timestamp === "string" ? parseLooseTimestamp(left.timestamp)?.getTime() ?? 0 : 0;
      const rightTime = typeof right.timestamp === "string" ? parseLooseTimestamp(right.timestamp)?.getTime() ?? 0 : 0;
      return rightTime - leftTime;
    })
    .slice(0, PERSONAL_MAX_NORMALIZED_ITEMS);
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
  mode?: "primary" | "deep_retry" | "json_retry";
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
  const jsonRetryInstruction = input.mode === "json_retry"
    ? `
Your previous reply was invalid JSON.
Retry now and return STRICT JSON ONLY.
- No prose before the JSON.
- No prose after the JSON.
- No markdown code fence.
- Keep summary.text concise and journalMarkdown short enough to avoid truncation.
- If needed, drop lower-priority details instead of producing malformed output.
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
${jsonRetryInstruction}

Meaningful signal rubric:
- Keep items that are actionable, durable, risky, time-sensitive, decision-relevant, or repeated across sources.
- Keep items that change what the assistant should remind, track, prepare, approve, or protect.
- Prefer user-specific work threads, approvals, meetings with preparation value, blockers, commitments, and security/financial issues.
- Treat an item as weak unless you can answer "why should a personal assistant remember this tomorrow?"

Noise handling:
- Do NOT surface items just because they are recent.
- Usually ignore generic marketing, event promotion, inspirational newsletters, routine tool notifications, OTP/verification emails, all-day placeholders like "Home", and passive FYI messages.
- Only keep those "normally noisy" items if the context shows a real downstream action or risk for the user.

Decision rule:
- Summary/highlights/candidate cards should focus on the top 1-3 threads that most deserve follow-up.
- It is better to omit weak items than to include filler.
- If an item is noisy but still included, explain the concrete reason it matters.
- You are expected to discard most inputs. A good Dreaming run is selective, not comprehensive.
- Summary and journal should mention only items that are still worth remembering tomorrow morning.
- If an item is not strong enough to justify a candidate card or durable memory, it usually should not appear in summary/highlights/journal.
- Do not mention "Home", OTP codes, or promotional/event-marketing emails unless they directly change a real user obligation, risk, or decision.

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
  "journalMarkdown": "# Dreaming Journal\\n\\n## YYYY-MM-DD · manual|auto\\n\\nNatural assistant-style diary entry",
  "goalDelta": {
    "changes": [
      {
        "action": "create|update|close",
        "key": "stable-goal-key",
        "reason": "Why this goal change is justified",
        "before": null,
        "after": { "title": "Goal title", "priority": "high", "summary": "Short summary", "status": "active" }
      }
    ]
  }
}
\`\`\`

Constraints:
- Prefer 0-3 candidate cards, only when genuinely useful.
- journalMarkdown must sound like a real diary entry written by a thoughtful personal assistant for the user.
- journalMarkdown should use a warm first-person assistant voice, like "今天我替你留意到..." or "今天我帮${"${currentProfile.displayName}"}记下...".
- If currentProfile.displayName is available, naturally mention the user's name once in journalMarkdown.
- journalMarkdown is a diary entry, not a status report, meeting recap, or changelog.
- journalMarkdown should connect the important threads into one coherent day narrative instead of listing tasks one by one.
- Never invent weather, mood, or offline life details unless they are directly supported by the provided context.
- highlights should be concrete, not generic categories.
- candidateCards.title/reason and goalDelta.reason/after.title/after.summary must be written in ${language}.
- goalDelta should stay empty when there is not enough evidence.
- Only use goalDelta for durable objectives, not one-off trivial tasks.
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
    rawInputs: trimRawInputsForPrompt(input.rawInputs),
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
  input: DreamingSummarizerInput,
): Promise<DreamSynthesis> {
  const runPass = async (mode: DreamingSummarizerInput["mode"]): Promise<DreamSynthesis | null> => {
    const sessionKey = `agent:dreaming:proactive-ai:${Date.now().toString(36)}`;
    const prompt = buildDreamingPrompt({ ...input, mode });
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
        if (mode !== "json_retry") return null;
        throw new Error(`Dreaming summarizer returned invalid JSON: ${text.slice(0, 200)}`);
      }
      return parsed;
    } finally {
      await api.runtime.subagent.deleteSession({
        sessionKey,
        deleteTranscript: false,
      }).catch(() => {});
    }
  };

  const primary = await runPass(input.mode);
  if (primary) return primary;
  const jsonRetry = await runPass("json_retry");
  if (jsonRetry) return jsonRetry;
  throw new Error("Dreaming summarizer returned invalid JSON after retry");
}

function trimNormalizedInputsForPrompt(normalizedInputs: Record<string, unknown>): Record<string, unknown> {
  return trimPromptContextValue(normalizedInputs, {
    maxArrayItems: 80,
    maxObjectEntries: 40,
    maxStringLength: 1200,
    maxDepth: 5,
  }) as Record<string, unknown>;
}

function trimRawInputsForPrompt(rawInputs: Record<string, unknown>): Record<string, unknown> {
  return trimPromptContextValue(rawInputs, {
    maxArrayItems: 40,
    maxObjectEntries: 30,
    maxStringLength: 800,
    maxDepth: 4,
  }) as Record<string, unknown>;
}

function trimPromptContextValue(
  value: unknown,
  limits: {
    maxArrayItems: number;
    maxObjectEntries: number;
    maxStringLength: number;
    maxDepth: number;
  },
  depth = 0,
): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > limits.maxStringLength ? `${value.slice(0, limits.maxStringLength)}…` : value;
  }
  if (typeof value !== "object") return value;
  if (depth >= limits.maxDepth) {
    if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactText(item) ?? String(item));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 8)
        .map(([key, child]) => [key, compactText(child) ?? (typeof child === "object" ? "[object]" : child)]),
    );
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxArrayItems)
      .map((item) => trimPromptContextValue(item, limits, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, limits.maxObjectEntries)
      .map(([key, child]) => [key, trimPromptContextValue(child, limits, depth + 1)]),
  );
}

function writeArtifacts(
  artifactDir: string,
  payload: {
    meta: Record<string, unknown>;
    rawInputs: Record<string, unknown>;
    normalizedInputs: Record<string, unknown>;
    summary: DreamSummary;
    profileDelta: DreamProfileDelta;
    goalDelta: DreamGoalDelta;
    candidates: Array<Record<string, unknown>>;
  },
): string {
  ensureDir(artifactDir);
  writeFileSync(join(artifactDir, "meta.json"), JSON.stringify(payload.meta, null, 2));
  writeFileSync(join(artifactDir, "inputs.raw.json"), JSON.stringify(payload.rawInputs, null, 2));
  writeFileSync(join(artifactDir, "inputs.normalized.json"), JSON.stringify(payload.normalizedInputs, null, 2));
  writeFileSync(join(artifactDir, "summary.json"), JSON.stringify(payload.summary, null, 2));
  writeFileSync(join(artifactDir, "profile-delta.json"), JSON.stringify(payload.profileDelta, null, 2));
  writeFileSync(join(artifactDir, "goal-delta.json"), JSON.stringify(payload.goalDelta, null, 2));
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

async function executeDynamicConnectorTools(
  provider: PersonalProvider,
  connection: { toolkit: string; connectedAccountId: string | null },
  windowStart: string,
  windowEnd: string,
): Promise<{ toolRuns: ExecutedPersonalToolRun[]; attempts: number; skippedReason?: string }> {
  const candidates = await discoverDynamicPersonalToolCandidates(provider, connection.toolkit);
  if (candidates.length === 0) {
    return { toolRuns: [], attempts: 0, skippedReason: "No usable read tools discovered" };
  }

  const toolRuns: ExecutedPersonalToolRun[] = [];
  let attempts = 0;
  for (const candidate of candidates) {
    const variants = buildToolArgumentVariants(connection.toolkit, candidate.slug, candidate.schema, windowStart, windowEnd);
    if (variants.length === 0) continue;
    for (const args of variants) {
      const result = await withTimeout(
        `executeTool(${candidate.slug})`,
        provider.executeTool(candidate.slug, args, connection.connectedAccountId ?? undefined),
        PERSONAL_PROVIDER_TIMEOUT_MS,
      );
      attempts += 1;
      if (!result.success) {
        if (attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) {
          return { toolRuns, attempts, skippedReason: result.error ?? "Tool execution failed" };
        }
        continue;
      }
      const payload = result.data;
      const itemCount = inferItemCount(unwrapComposioDataPreview(payload));
      toolRuns.push({
        slug: candidate.slug,
        description: candidate.description,
        args,
        itemCount,
        payload,
      });
      if (toolRuns.length >= PERSONAL_MAX_TOOL_RUNS || attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) {
        return { toolRuns, attempts };
      }
      if (itemCount > 0) break;
    }
    if (toolRuns.length >= PERSONAL_MAX_TOOL_RUNS || attempts >= PERSONAL_MAX_TOOL_ATTEMPTS) break;
  }

  return {
    toolRuns,
    attempts,
    ...(toolRuns.length > 0 ? {} : { skippedReason: "No connector data returned in the current window" }),
  };
}

async function collectPersonal(ctx: CoreContext, windowStart: string, windowEnd: string): Promise<DreamSourceResult> {
  const provider = createPersonalProvider(ctx);
  const connections = await withTimeout(
    "discoverConnections(personal)",
    provider.discoverConnections(),
    PERSONAL_PROVIDER_TIMEOUT_MS,
  );
  const active = connections.filter((item) => item.status === "ACTIVE");
  const connectors: Record<string, unknown> = {};
  const normalized: Array<Record<string, unknown>> = [];

  for (const connection of active) {
    try {
      const { toolRuns, skippedReason } = await executeDynamicConnectorTools(provider, connection, windowStart, windowEnd);
      const connectorEntries = normalizeDynamicPersonalData(connection.toolkit, toolRuns, windowStart, windowEnd);
      normalized.push(...connectorEntries);
      connectors[connection.toolkit] = {
        status: connectorEntries.length > 0 ? "ok" : "skipped",
        itemCount: connectorEntries.length,
        toolRuns: toolRuns.map((toolRun) => ({
          slug: toolRun.slug,
          description: toolRun.description,
          args: toolRun.args,
          itemCount: toolRun.itemCount,
          payload: toolRun.payload,
        })),
        ...(connectorEntries.length > 0 ? {} : { reason: skippedReason ?? "No connector data returned in the current window" }),
      };
    } catch (error) {
      connectors[connection.toolkit] = {
        status: "error",
        itemCount: 0,
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
    if (!input.api?.runtime?.subagent) {
      throw new Error("Dreaming requires runtime subagent; no fallback is allowed");
    }
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
    const fallbackSummary = buildMinimalSummary(sourceStats, dreamingLanguage);
    let highlights: string[] = [];
    let candidates: Array<Record<string, unknown>> = [];
    let summary = fallbackSummary;
    let goalDelta = emptyGoalDelta();
    let markdown: string | null = null;
    let interestTopics: string[] | undefined;
    const summarizerInput: DreamingSummarizerInput = {
      locale: dreamingLanguage,
      trigger: input.run.trigger,
      startedAt: input.run.startedAt,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      currentProfile,
      sourceStats,
      rawInputs,
      normalizedInputs: trimNormalizedInputsForPrompt(normalizedInputs),
      mode: "primary",
    };
    const summarizer = {
      strategy: "subagent" as const,
      run: (mode: DreamingSummarizerInput["mode"]) =>
        runDreamingSummarizer(input.api as OpenClawPluginApi, { ...summarizerInput, mode }),
    };

    try {
      logDreamEvent(input, "summarizer_started", { strategy: summarizer.strategy });
      const synthesis = await summarizer.run("primary");
      candidates = sanitizeDreamCandidates(synthesis.candidateCards, nowIso);
      summary = normalizeDreamSummaryFromModel(synthesis, {
        ...buildMinimalSummary(sourceStats, dreamingLanguage),
        candidateCount: candidates.length,
      });
      highlights = Array.isArray(summary.highlights)
        ? summary.highlights.filter((item): item is string => typeof item === "string")
        : [];
      markdown = typeof synthesis.journalMarkdown === "string" && synthesis.journalMarkdown.trim().length > 0
        ? synthesis.journalMarkdown.trim()
        : null;
      interestTopics = Array.isArray(synthesis.interestTopics)
        ? synthesis.interestTopics.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : undefined;
      goalDelta = normalizeGoalDelta(synthesis.goalDelta);

      if (
        summary.kind === "no_new_data"
        && candidates.length === 0
        && hasConcretePersonalContext(normalizedInputs)
      ) {
        logDreamEvent(input, "summarizer_retry_started", {
          strategy: summarizer.strategy,
          reason: "no_new_data_with_personal_context",
        });
        const retrySynthesis = await summarizer.run("deep_retry");
        candidates = sanitizeDreamCandidates(retrySynthesis.candidateCards, nowIso);
        summary = normalizeDreamSummaryFromModel(retrySynthesis, {
          ...buildMinimalSummary(sourceStats, dreamingLanguage),
          candidateCount: candidates.length,
        });
        highlights = Array.isArray(summary.highlights)
          ? summary.highlights.filter((item): item is string => typeof item === "string")
          : [];
        markdown = typeof retrySynthesis.journalMarkdown === "string" && retrySynthesis.journalMarkdown.trim().length > 0
          ? retrySynthesis.journalMarkdown.trim()
          : markdown;
        interestTopics = Array.isArray(retrySynthesis.interestTopics)
          ? retrySynthesis.interestTopics.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : interestTopics;
        goalDelta = normalizeGoalDelta(retrySynthesis.goalDelta);
        logDreamEvent(input, "summarizer_retry_completed", {
          candidateCount: candidates.length,
          summaryKind: summary.kind,
        });
      }
      if (!markdown) {
        throw new Error("Dreaming summarizer returned no journalMarkdown");
      }
      logDreamEvent(input, "summarizer_completed", {
        candidateCount: candidates.length,
        summaryKind: summary.kind,
      });
    } catch (error) {
      logDreamEvent(input, "summarizer_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
      goalDelta,
      candidates,
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
      goalDelta,
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
        goalDelta,
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
      goalDelta: parseArtifactIfExists<DreamGoalDelta>(artifactDir, "goal-delta.json", run.goalDeltaJson ?? emptyGoalDelta()),
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

  try {
    const memoryRepository = await createMemoryRepository(input.ctx);
    const memoryEvents = buildDreamMemoryEvents(run);
    for (const event of memoryEvents) {
      await memoryRepository.recordEvent(event);
    }
    if (memoryEvents.length > 0) {
      await memory.consolidateMemoryEvents({
        profileId: DEFAULT_PROFILE_ID,
        memoryRepository,
      });
    }
  } catch {
    // Dream profile application remains the primary write; memory capture is best-effort.
  }

  return store.markApplied(input.runId);
}

export async function applyDreamGoals(input: ApplyDreamProfileInput): Promise<DreamRunRecord> {
  const root = resolveAppRootFromCtx(input.ctx);
  const store = new DreamRunStore(root);
  const run = store.assertCanApplyGoals(input.runId);
  const goalDelta = run.goalDeltaJson ?? emptyGoalDelta();
  if (goalDelta.changes.length === 0) {
    return store.markGoalsApplied(input.runId);
  }

  for (const change of goalDelta.changes) {
    if (change.action === "close") {
      await profile.closeGoal(input.ctx, change.key);
      continue;
    }
    const after = change.after ?? {};
    const title = compactText(after.title);
    if (!title) {
      throw new Error(`Goal change ${change.key} is missing a title`);
    }
    await profile.upsertGoal(input.ctx, {
      key: change.key,
      title,
      priority: compactText(after.priority) ?? undefined,
      summary: compactText(after.summary) ?? undefined,
    });
  }

  return store.markGoalsApplied(input.runId);
}
