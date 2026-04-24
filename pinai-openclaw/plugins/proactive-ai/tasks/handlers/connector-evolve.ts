/**
 * Phase B.1 — evolution agent for the connector.init pipeline.
 *
 * Given a fresh batch of items just imported via connector.init (Gmail
 * messages or Calendar events), ask an LLM to extract durable user facts
 * (interests, ongoing projects, key relationships, recurring topics) and
 * persist them as v3 memory rows linked back to the evolution_run that
 * connector.init opened.
 *
 * Self-contained per Hermes-style: prompt includes the sampled items,
 * the current profile summary, and the most recent memory subjects so
 * the agent doesn't duplicate. Caller is connector.init; this module is
 * never called directly by the scheduler.
 *
 * Failure semantics: LLM/parse failures record an error on the evolution
 * run but DO NOT raise — the connector.init task should still succeed
 * because raw + signals are valid even when extraction fails.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../../db.js';
import * as raw from '../../raw-db.js';
import { runAgent, parseAgentJson } from '../../pipeline/agent-runner.js';
import type { TaskLogger } from '../scheduler.js';

const MAX_PROMPT_ITEMS = 20;
const MAX_RECENT_MEMORY_SUBJECTS = 25;
const MAX_TEXT_LEN_PER_ITEM = 320;
const DEFAULT_TIMEOUT_MS = 60_000;

const NOOP_LOGGER: TaskLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type EvolveToolkit =
  | 'gmail' | 'googlecalendar'
  // Phase D round 1
  | 'slack' | 'notion' | 'googledrive';

export interface ConnectorEvolveOpts {
  toolkit: EvolveToolkit;
  evolutionRunId: string;
  /**
   * Items that were just freshly inserted into raw.db. We re-sample these
   * for the prompt; passing all 100 would blow the context budget.
   */
  gmail?: raw.GmailMessageInput[];
  gcal?: raw.GcalEventInput[];
  slack?: raw.SlackMessageInput[];
  notion?: raw.NotionPageInput[];
  gdrive?: raw.GdriveFileInput[];
}

export interface ConnectorEvolveDeps {
  /**
   * Inject the agent call to keep tests pure. Production passes an
   * adapter that calls runAgent(api, ...). Tests pass a mock that returns
   * canned LLM output.
   */
  agentRun?: AgentRunFn;
  /**
   * If `agentRun` is omitted but `api` is set, the default adapter wraps
   * runAgent(api, 'connector-evolve', system, user, timeout).
   */
  api?: OpenClawPluginApi;
  timeoutMs?: number;
  logger?: TaskLogger;
}

export type AgentRunFn = (systemPrompt: string, userMessage: string) => Promise<string>;

export interface ConnectorEvolveResult {
  memoriesWritten: number;
  memoryIds: string[];
  durationMs: number;
  /** True when the LLM call or parse failed; the evolution run records the error. */
  llmFailed: boolean;
  llmError?: string;
  /** The number of items actually sent into the prompt (after sampling). */
  itemsSampled: number;
}

interface AgentMemoryWrite {
  text?: unknown;
  subject?: unknown;
  quality?: unknown;
  confidence?: unknown;
  tags?: unknown;
}

interface AgentMemoryEnvelope {
  memories?: AgentMemoryWrite[];
}

export async function runConnectorEvolve(
  opts: ConnectorEvolveOpts,
  deps: ConnectorEvolveDeps = {},
): Promise<ConnectorEvolveResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const agentRun = resolveAgentRun(deps, timeoutMs);
  if (!agentRun) {
    // No api and no agentRun → can't actually call the LLM. Record the
    // skip on the evolution run so audit shows why nothing was written.
    logger.warn('[connector-evolve] no agent runtime; skipping');
    return {
      memoriesWritten: 0,
      memoryIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: false,
      itemsSampled: 0,
    };
  }

  const sampled = sampleItems(opts);
  if (sampled.totalItems === 0) {
    return {
      memoriesWritten: 0,
      memoryIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: false,
      itemsSampled: 0,
    };
  }

  const profile = await db.getProfile().catch(() => null);
  const recentSubjects = await snapshotRecentMemorySubjects().catch(() => []);

  const systemPrompt = buildSystemPrompt(opts.toolkit);
  const userMessage = buildUserMessage(opts.toolkit, sampled, profile, recentSubjects);

  let agentText: string;
  try {
    agentText = await agentRun(systemPrompt, userMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[connector-evolve] agent call failed: ${msg}`);
    return {
      memoriesWritten: 0,
      memoryIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: true,
      llmError: truncate(msg, 500),
      itemsSampled: sampled.totalItems,
    };
  }

  const parsed = parseAgentJson<AgentMemoryEnvelope>(agentText);
  if (!parsed) {
    logger.warn(`[connector-evolve] could not parse agent output: ${truncate(agentText, 200)}`);
    return {
      memoriesWritten: 0,
      memoryIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: true,
      llmError: 'agent output not parseable as JSON',
      itemsSampled: sampled.totalItems,
    };
  }

  const writes = sanitizeMemoryWrites(parsed.memories);
  const memoryIds: string[] = [];
  for (const w of writes) {
    try {
      const row = await db.addMemoryV3({
        text: w.text,
        source: `connector_init:${opts.toolkit}`,
        sourceRunId: opts.evolutionRunId,
        subject: w.subject,
        quality: w.quality,
        confidence: w.confidence,
        tags: w.tags,
      });
      memoryIds.push(row.id);
    } catch (err) {
      // One bad row shouldn't sink the rest. Log and continue.
      logger.warn(`[connector-evolve] memory write rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (memoryIds.length > 0) {
    await db.recordEvolutionDelta(opts.evolutionRunId, { memoriesWritten: memoryIds.length });
    await db.recordEvolutionRefsProduced(opts.evolutionRunId, 'memory', memoryIds);
    await db.markMemoryReferenced(memoryIds, opts.evolutionRunId);
  }

  return {
    memoriesWritten: memoryIds.length,
    memoryIds,
    durationMs: Date.now() - startedAt,
    llmFailed: false,
    itemsSampled: sampled.totalItems,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────

function buildSystemPrompt(toolkit: string): string {
  return `You extract DURABLE user facts from a fresh batch of ${toolkit} items the user just connected. Output is a single JSON object inside one fenced \`\`\`json block, with this shape:

{
  "memories": [
    {
      "text": "Short factual sentence about the user (≤200 chars).",
      "subject": "topic:<key>" | "work:<key>" | "person:<name>" | "preference:<key>" | null,
      "quality": 0.0-1.0,
      "confidence": 0.0-1.0,
      "tags": ["string", ...]
    }
  ]
}

Rules:
- Capture stable things: ongoing projects, recurring contacts, expressed interests, role/employer hints, schedule patterns. NOT one-off events.
- Skip routine signal: newsletters, automated notifications, OAuth confirmations, password resets, marketing email.
- quality dial: 0.4-0.6 for inferred facts, 0.6-0.8 for clearly-stated facts. Never above 0.85.
- confidence dial: how sure are you the fact is correct.
- Subject is a stable scoped key for de-duplication; reuse existing subjects from "Recent memory subjects" when they apply.
- DO NOT duplicate facts that already appear in "Recent memory subjects" — extend, supersede, or skip.
- Output valid JSON only. If nothing extractable: { "memories": [] }.
- No prose outside the json fence. Quote any internal quotes with 「」 or escape with \\".`;
}

interface SampledBundle {
  totalItems: number;
  gmail: Array<{ from?: string; subject?: string; snippet?: string; date?: string }>;
  gcal: Array<{ title?: string; start?: string; attendees?: string[] }>;
  slack: Array<{ user?: string; channel?: string; text?: string; date?: string }>;
  notion: Array<{ title?: string; preview?: string; edited?: string; parentType?: string }>;
  gdrive: Array<{ name?: string; mimeType?: string; modified?: string; owners?: string[] }>;
}

function sampleItems(opts: ConnectorEvolveOpts): SampledBundle {
  const gmail: SampledBundle['gmail'] = [];
  const gcal: SampledBundle['gcal'] = [];
  const slack: SampledBundle['slack'] = [];
  const notion: SampledBundle['notion'] = [];
  const gdrive: SampledBundle['gdrive'] = [];

  if (opts.gmail && opts.gmail.length > 0) {
    const sortedGmail = [...opts.gmail]
      .sort(byDescOccurredAt)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((m) => ({
        from: m.from ?? undefined,
        subject: truncate(m.subject ?? '', 120),
        snippet: truncate(m.snippet ?? '', MAX_TEXT_LEN_PER_ITEM),
        date: m.occurredAt,
      }));
    gmail.push(...sortedGmail);
  }
  if (opts.gcal && opts.gcal.length > 0) {
    const sortedGcal = [...opts.gcal]
      .sort(byDescStartAt)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((e) => ({
        title: truncate(e.title ?? '', 120),
        start: e.startAt ?? undefined,
        attendees: Array.isArray(e.attendees) ? e.attendees.slice(0, 6) : [],
      }));
    gcal.push(...sortedGcal);
  }
  if (opts.slack && opts.slack.length > 0) {
    const sortedSlack = [...opts.slack]
      .sort(byDescOccurredAt)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((m) => ({
        user: m.userName ?? m.userId ?? undefined,
        channel: m.channelName ?? m.channelId ?? undefined,
        text: truncate(m.text ?? '', MAX_TEXT_LEN_PER_ITEM),
        date: m.occurredAt,
      }));
    slack.push(...sortedSlack);
  }
  if (opts.notion && opts.notion.length > 0) {
    const sortedNotion = [...opts.notion]
      .sort(byDescLastEdited)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((p) => ({
        title: truncate(p.title ?? '', 120),
        preview: truncate(p.contentPreview ?? '', MAX_TEXT_LEN_PER_ITEM),
        edited: p.lastEditedTime ?? undefined,
        parentType: p.parentType ?? undefined,
      }));
    notion.push(...sortedNotion);
  }
  if (opts.gdrive && opts.gdrive.length > 0) {
    const sortedGdrive = [...opts.gdrive]
      .sort(byDescModified)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((f) => ({
        name: truncate(f.name ?? '', 160),
        mimeType: f.mimeType ?? undefined,
        modified: f.modifiedTime ?? undefined,
        owners: Array.isArray(f.owners) ? f.owners.slice(0, 6) : [],
      }));
    gdrive.push(...sortedGdrive);
  }

  return {
    totalItems: gmail.length + gcal.length + slack.length + notion.length + gdrive.length,
    gmail, gcal, slack, notion, gdrive,
  };
}

function buildUserMessage(
  toolkit: string,
  sampled: SampledBundle,
  profile: db.ProfileRow | null,
  recentSubjects: string[],
): string {
  const lines: string[] = [];
  lines.push(`Toolkit: ${toolkit}`);
  if (sampled.gmail.length > 0) {
    lines.push('', `Gmail items (${sampled.gmail.length} most recent):`);
    sampled.gmail.forEach((m, i) => {
      lines.push(`${i + 1}. From: ${m.from ?? '(unknown)'}  Subject: ${m.subject ?? '(none)'}`);
      if (m.snippet) lines.push(`   Snippet: ${m.snippet}`);
      if (m.date) lines.push(`   Date: ${m.date}`);
    });
  }
  if (sampled.gcal.length > 0) {
    lines.push('', `Calendar events (${sampled.gcal.length} most recent):`);
    sampled.gcal.forEach((e, i) => {
      lines.push(`${i + 1}. Title: ${e.title ?? '(no title)'}`);
      if (e.start) lines.push(`   Start: ${e.start}`);
      if (e.attendees && e.attendees.length > 0) lines.push(`   Attendees: ${e.attendees.join(', ')}`);
    });
  }
  if (sampled.slack.length > 0) {
    lines.push('', `Slack messages (${sampled.slack.length} most recent):`);
    sampled.slack.forEach((m, i) => {
      lines.push(`${i + 1}. ${m.user ?? '(unknown)'} in #${m.channel ?? 'unknown'}`);
      if (m.text) lines.push(`   ${m.text}`);
      if (m.date) lines.push(`   At: ${m.date}`);
    });
  }
  if (sampled.notion.length > 0) {
    lines.push('', `Notion pages (${sampled.notion.length} most recent):`);
    sampled.notion.forEach((p, i) => {
      lines.push(`${i + 1}. Title: ${p.title ?? '(untitled)'}${p.parentType ? ` [${p.parentType}]` : ''}`);
      if (p.preview) lines.push(`   Preview: ${p.preview}`);
      if (p.edited) lines.push(`   Edited: ${p.edited}`);
    });
  }
  if (sampled.gdrive.length > 0) {
    lines.push('', `Google Drive files (${sampled.gdrive.length} most recent):`);
    sampled.gdrive.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.name ?? '(unnamed)'}${f.mimeType ? ` · ${f.mimeType}` : ''}`);
      if (f.owners && f.owners.length > 0) lines.push(`   Owners: ${f.owners.join(', ')}`);
      if (f.modified) lines.push(`   Modified: ${f.modified}`);
    });
  }
  lines.push('', '── Current state ──');
  if (profile?.summary) {
    lines.push(`Profile summary: ${truncate(profile.summary, 600)}`);
  }
  if (recentSubjects.length > 0) {
    lines.push(`Recent memory subjects: ${recentSubjects.slice(0, MAX_RECENT_MEMORY_SUBJECTS).join(', ')}`);
  }
  lines.push('', 'Extract durable facts now.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Output sanitization
// ──────────────────────────────────────────────────────────────────────

interface SanitizedMemoryWrite {
  text: string;
  subject: string | null;
  quality: number;
  confidence: number;
  tags: string[];
}

function sanitizeMemoryWrites(input: AgentMemoryWrite[] | undefined): SanitizedMemoryWrite[] {
  if (!Array.isArray(input)) return [];
  const out: SanitizedMemoryWrite[] = [];
  for (const w of input) {
    if (!w || typeof w !== 'object') continue;
    const text = typeof w.text === 'string' ? w.text.trim() : '';
    if (!text) continue;
    const subject = typeof w.subject === 'string' ? w.subject.trim() || null : null;
    const quality = clampScore(w.quality, 0.5);
    const confidence = clampScore(w.confidence, 0.5);
    const tags = sanitizeTags(w.tags);
    out.push({
      text: truncate(text, 240),
      subject,
      quality,
      confidence,
      tags,
    });
  }
  return out;
}

function clampScore(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const t of value) {
    if (typeof t === 'string') {
      const trimmed = t.trim();
      if (trimmed) out.push(trimmed);
    }
    if (out.length >= 8) break;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function snapshotRecentMemorySubjects(): Promise<string[]> {
  const rows = await db.listMemoryV3({ limit: 80, orderBy: 'created_at', orderDirection: 'desc' });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!row.subject) continue;
    if (seen.has(row.subject)) continue;
    seen.add(row.subject);
    out.push(row.subject);
    if (out.length >= MAX_RECENT_MEMORY_SUBJECTS) break;
  }
  return out;
}

function byDescOccurredAt(a: { occurredAt?: string }, b: { occurredAt?: string }): number {
  const av = a.occurredAt ?? '';
  const bv = b.occurredAt ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescStartAt(a: { startAt?: string | null }, b: { startAt?: string | null }): number {
  const av = a.startAt ?? '';
  const bv = b.startAt ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescLastEdited(a: { lastEditedTime?: string | null }, b: { lastEditedTime?: string | null }): number {
  const av = a.lastEditedTime ?? '';
  const bv = b.lastEditedTime ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescModified(a: { modifiedTime?: string | null }, b: { modifiedTime?: string | null }): number {
  const av = a.modifiedTime ?? '';
  const bv = b.modifiedTime ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function truncate(value: string | null | undefined, maxLen: number): string {
  if (!value) return '';
  return value.length > maxLen ? value.slice(0, maxLen - 3) + '...' : value;
}

function resolveAgentRun(
  deps: ConnectorEvolveDeps,
  timeoutMs: number,
): AgentRunFn | null {
  if (deps.agentRun) return deps.agentRun;
  if (deps.api) {
    const api = deps.api;
    return (sys, user) => runAgent(api, 'connector-evolve', sys, user, timeoutMs);
  }
  return null;
}
