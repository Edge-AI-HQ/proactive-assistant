/**
 * connector.init handler — pulls a toolkit's recent items from Composio,
 * stores them in raw.db, derives personal_signals, and opens an
 * evolution_run that downstream evolution-agent passes can pick up.
 *
 * Phase B v0 supports Gmail + Google Calendar. Other toolkits return
 * `skipped` with reason `unsupported_toolkit_v0` — the task succeeds (so
 * the scheduler doesn't burn retries) and the reconciler won't re-enqueue
 * the same idempotency key.
 *
 * The handler is dependency-injectable for testing — production wires
 * `defaultComposioFetcher` at registration time, tests pass a mock that
 * returns canned Composio shapes.
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../../db.js';
import * as raw from '../../raw-db.js';
import {
  requireComposioApiKey,
  getComposioUserId,
} from '../../shared/composio-key.js';
import type { TaskHandler, TaskHandlerResult } from '../scheduler.js';
import {
  runConnectorEvolve,
  type AgentRunFn,
  type ConnectorEvolveResult,
} from './connector-evolve.js';

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

const SUPPORTED_TOOLKITS = ['gmail', 'googlecalendar'] as const;
type SupportedToolkit = typeof SUPPORTED_TOOLKITS[number];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface ConnectorInitPayload {
  toolkit: string;
  connectedAccountId: string;
  /** Items to pull. Clamped to [1, 500]. */
  limit?: number;
  /** Free-form trigger label for audit (e.g. "first_connect", "reconciler"). */
  reason?: string;
}

/**
 * Composio API fetcher. In production this is built from a real api key;
 * tests inject a mock that returns canned `/tools/execute/...` responses.
 *
 * The handler only ever calls `/tools/execute/<slug>` — no other endpoints.
 * That keeps the mock surface tiny.
 */
export type ComposioFetcher = (
  path: string,
  init?: { method: 'POST'; body: string },
) => Promise<any>;

export interface ConnectorInitDeps {
  /** When omitted, built lazily from requireComposioApiKey(). */
  fetcher?: ComposioFetcher;
  /** Test override for the Composio user_id. */
  userId?: string;
  /**
   * OpenClaw plugin API — used by the Phase B.1 evolve stage to spawn the
   * fact-extraction subagent. When omitted (Phase B v0 behavior), the
   * evolve stage opens + completes the evolution_run with refs but does
   * NOT call any LLM.
   */
  api?: OpenClawPluginApi;
  /** Timeout for the evolve agent call. Default 60_000 ms. */
  evolveTimeoutMs?: number;
  /**
   * Test hook: skip the runAgent path entirely and use this canned LLM
   * adapter instead. Wins over `api` when both are set.
   */
  evolveAgentRun?: AgentRunFn;
}

export interface ConnectorInitResult {
  toolkit: string;
  rawInserted: number;
  rawIgnored: number;
  signalsInserted: number;
  evolutionRunId: string | null;
  /** Phase B.1: count of memory rows extracted by the evolve agent. */
  memoriesWritten: number;
  /** Phase B.1: when set, evolve called LLM but it failed; raw + signals are still valid. */
  evolveError?: string;
  reason?: string;
}

export function createConnectorInitHandler(deps: ConnectorInitDeps = {}): TaskHandler {
  return async (ctx) => {
    const payload = ctx.task.payload as unknown as ConnectorInitPayload;

    // ── 1. Validate payload ────────────────────────────────────────────
    if (!payload?.toolkit || typeof payload.toolkit !== 'string') {
      return failHard('invalid_payload', 'missing toolkit');
    }
    if (!payload?.connectedAccountId || typeof payload.connectedAccountId !== 'string') {
      return failHard('invalid_payload', 'missing connectedAccountId');
    }

    const toolkit = payload.toolkit.toLowerCase();
    const limit = clampLimit(payload.limit);

    // ── 2. Kill switch ─────────────────────────────────────────────────
    const disabled = parseDisabledToolkits();
    if (disabled.has(toolkit)) {
      return {
        status: 'skipped',
        result: { toolkit, reason: 'toolkit_disabled' },
      };
    }

    // ── 3. Toolkit support check ───────────────────────────────────────
    if (!isSupportedToolkit(toolkit)) {
      // Phase B v0 only ships Gmail + GCal adapters. Other toolkits
      // succeed-as-skipped so the reconciler doesn't keep poking them.
      return {
        status: 'skipped',
        result: { toolkit, reason: 'unsupported_toolkit_v0' },
      };
    }

    // ── 4. Resolve API key + fetcher ───────────────────────────────────
    let fetcher: ComposioFetcher;
    let userId: string;
    if (deps.fetcher) {
      fetcher = deps.fetcher;
      userId = deps.userId ?? getComposioUserId();
    } else {
      try {
        const apiKey = requireComposioApiKey();
        fetcher = makeDefaultFetcher(apiKey);
        userId = deps.userId ?? getComposioUserId();
      } catch (err) {
        return failHard(
          'no_api_key',
          err instanceof Error ? err.message : 'COMPOSIO_API_KEY not configured',
        );
      }
    }

    // ── 5. Stage: fetch ────────────────────────────────────────────────
    if (!(await ctx.heartbeat({ stage: 'fetch', toolkit, limit }))) {
      return abortLeaseLost('fetch');
    }

    let typedItems: { gmail?: raw.GmailMessageInput[]; gcal?: raw.GcalEventInput[] };
    try {
      typedItems = await fetchToolkitItems(toolkit, {
        fetcher,
        userId,
        connectedAccountId: payload.connectedAccountId,
        limit,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        errorCode: 'composio_fetch_failed',
        errorMessage: msg,
      };
    }

    // ── 6. Stage: raw upsert ───────────────────────────────────────────
    if (!(await ctx.heartbeat({ stage: 'raw', toolkit }))) {
      return abortLeaseLost('raw');
    }

    let rawInserted = 0;
    let rawIgnored = 0;
    const insertedRawIds: { gmail: string[]; gcal: string[] } = { gmail: [], gcal: [] };
    if (typedItems.gmail && typedItems.gmail.length > 0) {
      const r = raw.ingestGmailMessages(typedItems.gmail);
      rawInserted += r.inserted;
      rawIgnored += r.ignored;
      insertedRawIds.gmail = r.ids;
    }
    if (typedItems.gcal && typedItems.gcal.length > 0) {
      const r = raw.ingestGcalEvents(typedItems.gcal);
      rawInserted += r.inserted;
      rawIgnored += r.ignored;
      insertedRawIds.gcal = r.ids;
    }

    // ── 7. Stage: derive personal_signals ──────────────────────────────
    if (!(await ctx.heartbeat({ stage: 'signals', toolkit, rawInserted }))) {
      return abortLeaseLost('signals');
    }

    const signalInputs = buildSignalsForInit(toolkit, payload.connectedAccountId, {
      gmailRows: typedItems.gmail ?? [],
      gmailIds: insertedRawIds.gmail,
      gcalRows: typedItems.gcal ?? [],
      gcalIds: insertedRawIds.gcal,
    });
    const signalsRes = await db.ingestPersonalSignals(signalInputs);

    // ── 8. Stage: open evolution_run with refs (no agent prompt yet) ───
    if (!(await ctx.heartbeat({ stage: 'evolve', toolkit, signalsInserted: signalsRes.inserted }))) {
      return abortLeaseLost('evolve');
    }

    let evolutionRunId: string | null = null;
    let evolveResult: ConnectorEvolveResult | null = null;
    try {
      const evo = await db.createEvolutionRun({
        triggerKind: 'on_event',
        contextSummary: `connector.init ${toolkit}: ${rawInserted} raw, ${signalsRes.inserted} signals (${payload.reason ?? 'enqueue'})`,
      });
      evolutionRunId = evo.id;
      if (insertedRawIds.gmail.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'gmail_messages', insertedRawIds.gmail);
      }
      if (insertedRawIds.gcal.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'gcal_events', insertedRawIds.gcal);
      }
      if (signalsRes.ids.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'personal_signals', signalsRes.ids);
      }

      // Phase B.1: evolve. If the caller wired an LLM (api or test agentRun),
      // run the fact-extraction pass; otherwise leave evolution_run empty.
      // Either way, the run is marked completed at the end so it doesn't
      // sit 'running' forever.
      if (deps.api || deps.evolveAgentRun) {
        evolveResult = await runConnectorEvolve(
          {
            toolkit: toolkit as 'gmail' | 'googlecalendar',
            evolutionRunId: evo.id,
            gmail: typedItems.gmail,
            gcal: typedItems.gcal,
          },
          {
            api: deps.api,
            agentRun: deps.evolveAgentRun,
            timeoutMs: deps.evolveTimeoutMs,
            logger: ctx.logger,
          },
        );
      }

      if (evolveResult?.llmFailed) {
        await db.failEvolutionRun(evo.id, evolveResult.llmError ?? 'evolve agent failed');
      } else {
        await db.completeEvolutionRun(evo.id, {
          durationMs: evolveResult?.durationMs,
        });
      }
    } catch (err) {
      // Evolution bookkeeping failure shouldn't undo the raw + signals
      // writes (those have idempotency on dedupe_key). Log via task error
      // surface and let the next attempt re-record.
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`[connector.init] evolution bookkeeping failed: ${msg}`);
    }

    const result: ConnectorInitResult = {
      toolkit,
      rawInserted,
      rawIgnored,
      signalsInserted: signalsRes.inserted,
      evolutionRunId,
      memoriesWritten: evolveResult?.memoriesWritten ?? 0,
      ...(evolveResult?.llmFailed && evolveResult.llmError
        ? { evolveError: evolveResult.llmError }
        : {}),
      reason: payload.reason,
    };
    return { status: 'succeeded', result: result as unknown as Record<string, unknown> };
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-toolkit fetch + map
// ──────────────────────────────────────────────────────────────────────

interface FetchToolkitItemsOpts {
  fetcher: ComposioFetcher;
  userId: string;
  connectedAccountId: string;
  limit: number;
}

async function fetchToolkitItems(
  toolkit: SupportedToolkit,
  opts: FetchToolkitItemsOpts,
): Promise<{ gmail?: raw.GmailMessageInput[]; gcal?: raw.GcalEventInput[] }> {
  if (toolkit === 'gmail') {
    return { gmail: await fetchGmailRecent(opts) };
  }
  if (toolkit === 'googlecalendar') {
    return { gcal: await fetchGcalRecent(opts) };
  }
  // Defensive — isSupportedToolkit already screened this out
  return {};
}

async function fetchGmailRecent(opts: FetchToolkitItemsOpts): Promise<raw.GmailMessageInput[]> {
  const response = await opts.fetcher('/tools/execute/GMAIL_FETCH_EMAILS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        include_payload: true,
        verbose: true,
      },
    }),
  });
  const messages = extractGmailMessages(response);
  return messages.map(mapGmailMessage).filter((m): m is raw.GmailMessageInput => !!m?.messageId);
}

async function fetchGcalRecent(opts: FetchToolkitItemsOpts): Promise<raw.GcalEventInput[]> {
  // GCal is a window-not-count source. We pull a 30-day-back / 90-day-forward
  // band so the user sees both recent past + near-future when the chip first
  // turns green. limit caps total event count after the merge.
  const now = Date.now();
  const timeMin = new Date(now - 30 * 86_400_000).toISOString();
  const timeMax = new Date(now + 90 * 86_400_000).toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        time_min: timeMin,
        time_max: timeMax,
        single_events: true,
        summary_only: false,
        max_results: opts.limit,
      },
    }),
  });
  const events = extractGcalEvents(response);
  return events
    .map(mapGcalEvent)
    .filter((e): e is raw.GcalEventInput => !!e?.eventId && !!e?.calendarId)
    .slice(0, opts.limit);
}

// ──────────────────────────────────────────────────────────────────────
// Composio response shape extractors — defensive against API shape drift.
// Composio wraps the real payload variously: { data: {...} } /
// { response_data: {...} } / { messages: [...] } directly. Walk both
// nesting paths, then fall back to "any array of objects on the top level".
// ──────────────────────────────────────────────────────────────────────

function extractGmailMessages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    if (Array.isArray(c?.messages)) return c.messages;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function extractGcalEvents(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    if (Array.isArray(c?.events)) return c.events;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function unwrapDataPaths(response: unknown): any[] {
  if (response == null || typeof response !== 'object') return [];
  const out: any[] = [response];
  const r = response as Record<string, unknown>;
  if (r.data && typeof r.data === 'object') out.push(r.data);
  if (r.response_data && typeof r.response_data === 'object') out.push(r.response_data);
  // Composio sometimes wraps inside .data.response_data
  const inner = (r.data as any)?.response_data;
  if (inner && typeof inner === 'object') out.push(inner);
  return out;
}

function mapGmailMessage(msg: any): raw.GmailMessageInput | null {
  if (!msg || typeof msg !== 'object') return null;
  const messageId = String(msg.id ?? msg.messageId ?? '').trim();
  if (!messageId) return null;
  const headers = readGmailHeaders(msg);
  return {
    messageId,
    threadId: msg.threadId ?? msg.thread_id ?? null,
    from: headers['from'] ?? msg.from ?? null,
    to: parseAddressList(headers['to']),
    cc: parseAddressList(headers['cc']),
    subject: headers['subject'] ?? msg.subject ?? null,
    snippet: msg.snippet ?? null,
    body: typeof msg.body === 'string' ? msg.body : extractGmailBody(msg) ?? null,
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    internalDate: msg.internalDate ?? msg.internal_date ?? null,
    occurredAt: parseGmailTimestamp(msg.internalDate ?? msg.internal_date),
  };
}

function readGmailHeaders(msg: any): Record<string, string> {
  const headers = msg.payload?.headers ?? msg.headers ?? [];
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h?.name && typeof h.value === 'string') {
        out[h.name.toLowerCase()] = h.value;
      }
    }
  }
  return out;
}

function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function extractGmailBody(msg: any): string | null {
  // Walk payload.body.data → base64; fallback to first text/plain part.
  const payload = msg.payload;
  if (!payload || typeof payload !== 'object') return null;
  const body = payload.body;
  if (body?.data && typeof body.data === 'string') {
    try { return Buffer.from(body.data, 'base64url').toString('utf-8'); } catch { /* ignore */ }
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    if (part?.mimeType === 'text/plain' && part.body?.data) {
      try { return Buffer.from(part.body.data, 'base64url').toString('utf-8'); } catch { /* ignore */ }
    }
  }
  return null;
}

function parseGmailTimestamp(value: unknown): string | undefined {
  // Gmail's internalDate is a string of milliseconds since epoch.
  if (value == null) return undefined;
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function mapGcalEvent(evt: any): raw.GcalEventInput | null {
  if (!evt || typeof evt !== 'object') return null;
  const eventId = String(evt.id ?? evt.eventId ?? '').trim();
  // Composio's event objects don't always carry the calendarId; default to
  // 'primary' which is what GMAIL/GCal queries against single-calendar UIs return.
  const calendarId = String(
    evt.calendarId ?? evt.calendar_id ?? evt.organizer?.email ?? 'primary',
  ).trim();
  if (!eventId || !calendarId) return null;
  return {
    eventId,
    calendarId,
    title: evt.summary ?? evt.title ?? null,
    description: evt.description ?? null,
    location: evt.location ?? null,
    startAt: extractGcalTimestamp(evt.start),
    endAt: extractGcalTimestamp(evt.end),
    attendees: Array.isArray(evt.attendees)
      ? evt.attendees.map((a: any) => String(a?.email ?? a)).filter(Boolean)
      : [],
    status: evt.status ?? null,
  };
}

function extractGcalTimestamp(node: any): string | null {
  if (!node || typeof node !== 'object') return null;
  return node.dateTime ?? node.date ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Signal derivation — one signal per ingested raw row, with refs.
// ──────────────────────────────────────────────────────────────────────

function buildSignalsForInit(
  toolkit: string,
  connectedAccountId: string,
  buckets: {
    gmailRows: raw.GmailMessageInput[];
    gmailIds: string[];
    gcalRows: raw.GcalEventInput[];
    gcalIds: string[];
  },
): db.IngestPersonalSignalInput[] {
  const out: db.IngestPersonalSignalInput[] = [];
  // Pair each freshly-inserted raw id with its source row by index. Note
  // ingestGmailMessages skips rows with falsy messageId, so the raw input
  // arrays are NOT 1:1 with the result `ids` — we rebuild the mapping by
  // dedupe_key on the row, but for our derived shape the index alignment
  // holds because mapGmailMessage filters to non-null messageId before ingest.
  for (let i = 0; i < buckets.gmailIds.length; i += 1) {
    const row = buckets.gmailRows[i];
    if (!row) continue;
    // ingestPersonalSignals silently drops rows whose `summary` is falsy,
    // so always fall back to title (then a placeholder) rather than ''.
    const title = trimSummary(row.subject ?? row.snippet ?? '(no subject)', 120);
    const summary = trimSummary(row.snippet ?? row.subject ?? title, 280) || title;
    out.push({
      kind: 'connector.gmail.message',
      title,
      summary,
      payload: { from: row.from, subject: row.subject, threadId: row.threadId },
      source: `connector:${toolkit}`,
      sourceRawTable: 'gmail_messages',
      sourceRawIds: [buckets.gmailIds[i]!],
      occurredAt: row.occurredAt,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.messageId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.gcalIds.length; i += 1) {
    const row = buckets.gcalRows[i];
    if (!row) continue;
    const startAt = row.startAt ?? undefined;
    const title = trimSummary(row.title ?? '(untitled event)', 120);
    // Same trap as Gmail above: empty description/location must not produce
    // an empty summary, otherwise the signal silently disappears.
    const summary = trimSummary(row.description ?? row.location ?? title, 280) || title;
    out.push({
      kind: 'connector.gcal.event',
      title,
      summary,
      payload: { startAt, endAt: row.endAt, location: row.location },
      source: `connector:${toolkit}`,
      sourceRawTable: 'gcal_events',
      sourceRawIds: [buckets.gcalIds[i]!],
      occurredAt: startAt,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.calendarId}:${row.eventId}:init:v1`,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────────────────────────────

function isSupportedToolkit(t: string): t is SupportedToolkit {
  return (SUPPORTED_TOOLKITS as readonly string[]).includes(t);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseDisabledToolkits(): Set<string> {
  const raw = process.env.CONNECTOR_INIT_DISABLED_TOOLKITS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function trimSummary(value: string | null | undefined, maxLen: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 3) + '...' : trimmed;
}

function failHard(code: string, message: string): TaskHandlerResult {
  return { status: 'failed', errorCode: code, errorMessage: message };
}

function abortLeaseLost(stage: string): TaskHandlerResult {
  // When heartbeat returns false, the scheduler/reaper will reattempt.
  // Returning failed here ties up the attempt count, but the lease-lost
  // path in the scheduler also bypasses persistence. Treat as failed so
  // diagnostic surface is honest.
  return {
    status: 'failed',
    errorCode: 'lease_lost',
    errorMessage: `lease lost during stage=${stage}`,
  };
}

function makeDefaultFetcher(apiKey: string): ComposioFetcher {
  return async (path, init) => {
    const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
      ...(init as any),
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    });
    const text = await response.text();
    const data = text.trim() ? JSON.parse(text) : {};
    if (!response.ok) {
      const msg = data?.message ?? data?.error ?? text.slice(0, 200);
      throw new Error(`Composio API ${response.status}: ${msg}`);
    }
    return data;
  };
}
