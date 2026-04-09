import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { resolveAppRoot } from "../../core/paths.js";

export interface TraceRuntime {
  homeDir: string;
  env: Record<string, string | undefined>;
}

export interface TraceEventRecord {
  timestamp: string;
  iteration?: number;
  phase: string;
  kind: string;
  name: string;
  durationMs?: number;
  message?: string;
  attrs?: Record<string, unknown>;
}

export interface PipelineTracePayload {
  iteration?: number;
  phase: string;
  kind: string;
  name: string;
  durationMs?: number;
  message?: string;
  attrs?: Record<string, unknown>;
  timestamp?: string;
}

interface GatewayLineLike {
  time?: string;
  _meta?: {
    date?: string;
    logLevelName?: string;
  };
  [key: string]: unknown;
}

export interface GatewayAnomalyWindow {
  runId: string;
  startedAt: string;
  endedAt: string;
}

interface InputSummary {
  type: string;
  length: number;
  keys: string[];
  hash: string;
}

const SECRET_FLAG_RE = /(token|api[-_]?key|secret|password|authorization|webhook)/i;
const ANOMALY_PATTERNS = [
  /read tool called without path/i,
  /web_search failed/i,
  /tool .*failed/i,
  /agent\/embedded/i,
];

function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function proactiveAiRoot(runtime: TraceRuntime): string {
  return join(resolveAppRoot(runtime.env, runtime.homeDir), "proactive-ai");
}

export function getTraceDir(runtime: TraceRuntime): string {
  return join(proactiveAiRoot(runtime), "traces");
}

export function getRunTracePath(runtime: TraceRuntime, runId: string): string {
  return join(getTraceDir(runtime), `${runId}.ndjson`);
}

export function getCliTracePath(runtime: TraceRuntime): string {
  return join(proactiveAiRoot(runtime), "cli-trace.ndjson");
}

async function ensureTraceDir(runtime: TraceRuntime): Promise<void> {
  await mkdir(getTraceDir(runtime), { recursive: true });
}

export async function appendRunTraceEvent(
  runtime: TraceRuntime,
  runId: string,
  event: TraceEventRecord,
): Promise<void> {
  await ensureTraceDir(runtime);
  await appendFile(
    getRunTracePath(runtime, runId),
    toJsonLine({ runId, ...event }),
    "utf8",
  );
}

export async function appendCliTraceEvent(
  runtime: TraceRuntime,
  event: Record<string, unknown>,
): Promise<void> {
  const target = getCliTracePath(runtime);
  await mkdir(proactiveAiRoot(runtime), { recursive: true });
  await appendFile(target, toJsonLine(event), "utf8");
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function summarizeInput(value: string): InputSummary {
  try {
    const parsed = JSON.parse(value);
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).sort()
      : [];
    return {
      type: Array.isArray(parsed) ? "json-array" : typeof parsed === "object" && parsed ? "json-object" : typeof parsed,
      length: value.length,
      keys,
      hash: hashString(value),
    };
  } catch {
    return {
      type: "raw",
      length: value.length,
      keys: [],
      hash: hashString(value),
    };
  }
}

function extractCommandTokens(argv: string[]): string[] {
  const tokens: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    tokens.push(arg);
  }
  return tokens;
}

export function redactCliArgv(argv: string[]): {
  domain: string;
  command: string;
  argvRedacted: Array<string | Record<string, unknown>>;
} {
  const commandTokens = extractCommandTokens(argv);
  const domain = commandTokens[0] ?? "cli";
  const command = commandTokens.join(" ") || "cli";
  const argvRedacted: Array<string | Record<string, unknown>> = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--input") {
      argvRedacted.push(arg);
      const next = argv[i + 1] ?? "";
      argvRedacted.push({ input: summarizeInput(next) });
      i += 1;
      continue;
    }

    if (arg.startsWith("--input=")) {
      argvRedacted.push({
        input: summarizeInput(arg.slice("--input=".length)),
      });
      continue;
    }

    if (SECRET_FLAG_RE.test(arg)) {
      argvRedacted.push(arg);
      if (!arg.includes("=") && i + 1 < argv.length) {
        argvRedacted.push("[redacted]");
        i += 1;
      }
      continue;
    }

    const [flagName] = arg.split("=", 1);
    if (flagName && SECRET_FLAG_RE.test(flagName)) {
      argvRedacted.push(`${flagName}=[redacted]`);
      continue;
    }

    argvRedacted.push(arg);
  }

  return { domain, command, argvRedacted };
}

function parseGatewayLine(line: string): GatewayLineLike | null {
  try {
    return JSON.parse(line) as GatewayLineLike;
  } catch {
    return null;
  }
}

function extractGatewayMessage(entry: GatewayLineLike): string {
  const message = entry["1"];
  if (typeof message === "string") return message;
  if (typeof entry.message === "string") return entry.message;
  return "";
}

function extractGatewayTime(entry: GatewayLineLike): string | null {
  return entry.time ?? entry._meta?.date ?? null;
}

function extractGatewayLevel(entry: GatewayLineLike): string | null {
  return entry._meta?.logLevelName ?? null;
}

function extractGatewaySubsystem(entry: GatewayLineLike): string | null {
  const raw = entry["0"];
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { subsystem?: string };
    return parsed.subsystem ?? null;
  } catch {
    return raw;
  }
}

function isInWindow(timestamp: string, startedAt: string, endedAt: string): boolean {
  const time = Date.parse(timestamp);
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(time) && time >= start && time <= end;
}

function isGatewayAnomaly(message: string, subsystem: string | null, level: string | null): boolean {
  if (ANOMALY_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if ((subsystem === "agent/embedded" || subsystem === "gateway") && (level === "WARN" || level === "ERROR")) {
    return true;
  }
  return false;
}

export function parseGatewayAnomalyLines(
  lines: string[],
  window: GatewayAnomalyWindow,
): TraceEventRecord[] {
  const events: TraceEventRecord[] = [];

  for (const line of lines) {
    const parsed = parseGatewayLine(line);
    if (!parsed) continue;

    const timestamp = extractGatewayTime(parsed);
    if (!timestamp || !isInWindow(timestamp, window.startedAt, window.endedAt)) continue;

    const message = extractGatewayMessage(parsed);
    const subsystem = extractGatewaySubsystem(parsed);
    const level = extractGatewayLevel(parsed);
    if (!isGatewayAnomaly(message, subsystem, level)) continue;

    events.push({
      timestamp,
      phase: "gateway",
      kind: "gateway.anomaly",
      name: subsystem ?? "gateway",
      attrs: {
        level,
        subsystem,
        message,
      },
    });
  }

  return events;
}

export async function collectGatewayAnomalies(
  window: GatewayAnomalyWindow,
): Promise<TraceEventRecord[]> {
  const dir = "/tmp/openclaw";
  let files: string[] = [];
  try {
    files = (await readdir(dir))
      .filter((name) => name.startsWith("openclaw-") && name.endsWith(".log"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }

  const events: TraceEventRecord[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      const parsed = parseGatewayAnomalyLines(content.split(/\r?\n/).filter(Boolean), window);
      for (const event of parsed) {
        events.push({
          ...event,
          attrs: {
            ...(event.attrs ?? {}),
            logFile: basename(file),
          },
        });
      }
    } catch {
      // best effort
    }
  }

  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
