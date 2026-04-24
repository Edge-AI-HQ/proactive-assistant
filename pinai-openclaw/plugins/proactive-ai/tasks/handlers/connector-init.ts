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

const SUPPORTED_TOOLKITS = [
  'gmail',
  'googlecalendar',
  // Phase D round 1
  'slack',
  'notion',
  'googledrive',
  // Phase D round 2
  'github',
  'outlook',
] as const;
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

    let typedItems: TypedFetchedItems;
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
    const insertedRawIds: InsertedRawIds = {
      gmail: [], gcal: [], slack: [], notion: [], gdrive: [], github: [], outlook: [],
    };
    if (typedItems.gmail && typedItems.gmail.length > 0) {
      const r = raw.ingestGmailMessages(typedItems.gmail);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gmail = r.ids;
    }
    if (typedItems.gcal && typedItems.gcal.length > 0) {
      const r = raw.ingestGcalEvents(typedItems.gcal);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gcal = r.ids;
    }
    if (typedItems.slack && typedItems.slack.length > 0) {
      const r = raw.ingestSlackMessages(typedItems.slack);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.slack = r.ids;
    }
    if (typedItems.notion && typedItems.notion.length > 0) {
      const r = raw.ingestNotionPages(typedItems.notion);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.notion = r.ids;
    }
    if (typedItems.gdrive && typedItems.gdrive.length > 0) {
      const r = raw.ingestGdriveFiles(typedItems.gdrive);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gdrive = r.ids;
    }
    if (typedItems.github && typedItems.github.length > 0) {
      const r = raw.ingestGithubIssues(typedItems.github);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.github = r.ids;
    }
    if (typedItems.outlook && typedItems.outlook.length > 0) {
      const r = raw.ingestOutlookMessages(typedItems.outlook);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.outlook = r.ids;
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
      slackRows: typedItems.slack ?? [],
      slackIds: insertedRawIds.slack,
      notionRows: typedItems.notion ?? [],
      notionIds: insertedRawIds.notion,
      gdriveRows: typedItems.gdrive ?? [],
      gdriveIds: insertedRawIds.gdrive,
      githubRows: typedItems.github ?? [],
      githubIds: insertedRawIds.github,
      outlookRows: typedItems.outlook ?? [],
      outlookIds: insertedRawIds.outlook,
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
      if (insertedRawIds.slack.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'slack_messages', insertedRawIds.slack);
      }
      if (insertedRawIds.notion.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'notion_pages', insertedRawIds.notion);
      }
      if (insertedRawIds.gdrive.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'gdrive_files', insertedRawIds.gdrive);
      }
      if (insertedRawIds.github.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'github_issues', insertedRawIds.github);
      }
      if (insertedRawIds.outlook.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'outlook_messages', insertedRawIds.outlook);
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
            toolkit: toolkit as SupportedToolkit,
            evolutionRunId: evo.id,
            gmail: typedItems.gmail,
            gcal: typedItems.gcal,
            slack: typedItems.slack,
            notion: typedItems.notion,
            gdrive: typedItems.gdrive,
            github: typedItems.github,
            outlook: typedItems.outlook,
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

interface TypedFetchedItems {
  gmail?: raw.GmailMessageInput[];
  gcal?: raw.GcalEventInput[];
  slack?: raw.SlackMessageInput[];
  notion?: raw.NotionPageInput[];
  gdrive?: raw.GdriveFileInput[];
  github?: raw.GithubIssueInput[];
  outlook?: raw.OutlookMessageInput[];
}

interface InsertedRawIds {
  gmail: string[];
  gcal: string[];
  slack: string[];
  notion: string[];
  gdrive: string[];
  github: string[];
  outlook: string[];
}

async function fetchToolkitItems(
  toolkit: SupportedToolkit,
  opts: FetchToolkitItemsOpts,
): Promise<TypedFetchedItems> {
  if (toolkit === 'gmail') {
    return { gmail: await fetchGmailRecent(opts) };
  }
  if (toolkit === 'googlecalendar') {
    return { gcal: await fetchGcalRecent(opts) };
  }
  if (toolkit === 'slack') {
    return { slack: await fetchSlackRecent(opts) };
  }
  if (toolkit === 'notion') {
    return { notion: await fetchNotionRecent(opts) };
  }
  if (toolkit === 'googledrive') {
    return { gdrive: await fetchGdriveRecent(opts) };
  }
  if (toolkit === 'github') {
    return { github: await fetchGithubRecent(opts) };
  }
  if (toolkit === 'outlook') {
    return { outlook: await fetchOutlookRecent(opts) };
  }
  // Defensive — isSupportedToolkit already screened this out
  return {};
}

async function fetchGmailRecent(opts: FetchToolkitItemsOpts): Promise<raw.GmailMessageInput[]> {
  // verbose=false is the magic flag: the schema docs it as "optimized
  // concurrent metadata fetching for faster performance (~75%
  // improvement)" — and crucially it shrinks the response enough to
  // pull 100+ messages without hitting Composio's payload cap. With
  // verbose=true (default) anything > ~30 messages 413s.
  // include_payload=true keeps headers + body so signal derivation has
  // real text to work with.
  const response = await opts.fetcher('/tools/execute/GMAIL_FETCH_EMAILS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        verbose: false,
        include_payload: true,
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
  //
  // Slug is GOOGLECALENDAR_EVENTS_LIST (the _ALL_CALENDARS variant doesn't
  // exist as a Composio tool). Single calendar at a time — we hit primary;
  // if a user wants secondary calendars, we'd need a separate fetch loop.
  // Args are camelCase: timeMin, timeMax, singleEvents, maxResults.
  const now = Date.now();
  const timeMin = new Date(now - 30 * 86_400_000).toISOString();
  const timeMax = new Date(now + 90 * 86_400_000).toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLECALENDAR_EVENTS_LIST', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        maxResults: opts.limit,
      },
    }),
  });
  const events = extractGcalEvents(response);
  return events
    .map(mapGcalEvent)
    .filter((e): e is raw.GcalEventInput => !!e?.eventId && !!e?.calendarId)
    .slice(0, opts.limit);
}

async function fetchSlackRecent(opts: FetchToolkitItemsOpts): Promise<raw.SlackMessageInput[]> {
  // Slack search returns recent messages user has access to across all
  // channels they're in. `*` is the catch-all; sort=timestamp puts most
  // recent first (matching the dreaming/sources.ts variant).
  const response = await opts.fetcher('/tools/execute/SLACK_SEARCH_MESSAGES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        query: '*',
        count: opts.limit,
        sort: 'timestamp',
        sort_dir: 'desc',
        include_bots: false,
      },
    }),
  });
  const messages = extractSlackMessages(response);
  return messages
    .map(mapSlackMessage)
    .filter((m): m is raw.SlackMessageInput => !!m?.channelId && !!m?.ts)
    .slice(0, opts.limit);
}

async function fetchNotionRecent(opts: FetchToolkitItemsOpts): Promise<raw.NotionPageInput[]> {
  // Composio's NOTION_FETCH_DATA expects a boolean flag picker
  // (get_pages | get_databases | get_all), NOT a "fetch_type" string.
  // The schema docs misled us; the live error is "Exactly one data fetch
  // option must be selected".
  // Returns a SLIM shape: data.values: [{id, title, type}] only — no
  // last_edited_time, no parent, no body. The mapper picks up just what's
  // there; richer fields would need a per-page follow-up call.
  const response = await opts.fetcher('/tools/execute/NOTION_FETCH_DATA', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        get_pages: true,
        page_size: opts.limit,
      },
    }),
  });
  const pages = extractNotionPages(response);
  return pages
    .map(mapNotionPage)
    .filter((p): p is raw.NotionPageInput => !!p?.pageId)
    .slice(0, opts.limit);
}

async function fetchGithubRecent(opts: FetchToolkitItemsOpts): Promise<raw.GithubIssueInput[]> {
  // Pull issues + PRs assigned to the authenticated user across all repos
  // they have access to. Direction=desc puts most-recently-updated first;
  // since= caps the lookback window. Matches the variant dreaming/sources.ts
  // line 390 uses for the same toolkit.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  // Slug is GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER (with the
  // LIST_ prefix). The non-LIST form returns 404 — this caught us in the
  // first live smoke. Composio also caps per_page at 100.
  const response = await opts.fetcher('/tools/execute/GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        since,
        state: 'all',
        filter: 'assigned',
        per_page: opts.limit,
        direction: 'desc',
      },
    }),
  });
  const issues = extractGithubIssues(response);
  return issues
    .map(mapGithubIssue)
    .filter((i): i is raw.GithubIssueInput => !!i?.issueId)
    .slice(0, opts.limit);
}

async function fetchOutlookRecent(opts: FetchToolkitItemsOpts): Promise<raw.OutlookMessageInput[]> {
  // Microsoft Graph: /me/messages with $top, $orderby. Composio's
  // OUTLOOK_LIST_MESSAGES wraps these args under arguments.{top, orderby}.
  // We sort by receivedDateTime desc to mirror the Gmail "most recent" UX.
  const response = await opts.fetcher('/tools/execute/OUTLOOK_LIST_MESSAGES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        top: opts.limit,
        orderby: 'receivedDateTime desc',
      },
    }),
  });
  const messages = extractOutlookMessages(response);
  return messages
    .map(mapOutlookMessage)
    .filter((m): m is raw.OutlookMessageInput => !!m?.messageId)
    .slice(0, opts.limit);
}

async function fetchGdriveRecent(opts: FetchToolkitItemsOpts): Promise<raw.GdriveFileInput[]> {
  // Drive's q syntax: filter by modifiedTime, exclude trashed. corpora=user
  // restricts to files owned/shared with the user (vs. domain-wide).
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLEDRIVE_FIND_FILE', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        q: `modifiedTime > '${since}' and trashed = false`,
        page_size: opts.limit,
        spaces: 'drive',
        corpora: 'user',
      },
    }),
  });
  const files = extractGdriveFiles(response);
  return files
    .map(mapGdriveFile)
    .filter((f): f is raw.GdriveFileInput => !!f?.fileId)
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

function extractSlackMessages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Slack's search response wraps under messages.matches[]
    if (c?.messages && Array.isArray(c.messages?.matches)) return c.messages.matches;
    if (Array.isArray(c?.matches)) return c.matches;
    if (Array.isArray(c?.messages)) return c.messages;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function extractNotionPages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Composio NOTION_FETCH_DATA returns { data: { values: [...] } } — the
    // primary path. Notion's raw API uses { results: [...] }. Accept both.
    if (Array.isArray(c?.values)) return c.values;
    if (Array.isArray(c?.results)) return c.results;
    if (Array.isArray(c?.pages)) return c.pages;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function extractGdriveFiles(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Drive API: { files: [...] }
    if (Array.isArray(c?.files)) return c.files;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function extractGithubIssues(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Composio wraps under data.issues (verified 2026-04-24 live).
    // Raw GitHub API returns a top-level array; keep both fallbacks.
    if (Array.isArray(c?.issues)) return c.issues;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

function extractOutlookMessages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Microsoft Graph: { value: [...] }
    if (Array.isArray(c?.value)) return c.value;
    if (Array.isArray(c?.messages)) return c.messages;
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
  // Composio's GMAIL_FETCH_EMAILS returns a flattened shape (verified
  // 2026-04-24 against live API):
  //   {
  //     messageId, threadId, subject (string), sender (string),
  //     to (string — comma-separated, NOT an array),
  //     preview ({body, subject} — object, NOT a snippet string),
  //     messageText (full body string),
  //     messageTimestamp (ISO string like "2026-04-24T00:50:54Z"),
  //     labelIds (array), attachmentList (array), payload {body,filename,headers}
  //   }
  // Raw Gmail API instead returns:
  //   { id, threadId, payload: { headers: [{name,value}] }, snippet, internalDate (ms) }
  // Walk both shapes carefully because each field can be a string OR object
  // OR array depending on which producer fed us.
  const headers = readGmailHeaders(msg);
  // `to`/`cc` may be string ("a@x.com, b@x.com"), array, or absent
  const toList = Array.isArray(msg.to) ? msg.to.filter((s: any): s is string => typeof s === 'string')
    : typeof msg.to === 'string' ? parseAddressList(msg.to)
    : parseAddressList(headers['to']);
  const ccList = Array.isArray(msg.cc) ? msg.cc.filter((s: any): s is string => typeof s === 'string')
    : typeof msg.cc === 'string' ? parseAddressList(msg.cc)
    : parseAddressList(headers['cc']);
  // `preview` may be a string snippet (raw Gmail) OR an object {body,subject} (Composio)
  const snippetStr = typeof msg.snippet === 'string' ? msg.snippet
    : typeof msg.preview === 'string' ? msg.preview
    : (msg.preview && typeof msg.preview === 'object' && typeof msg.preview.body === 'string')
      ? msg.preview.body
      : null;
  // Body: Composio gives messageText, raw Gmail gives msg.body or payload.body
  const bodyStr = typeof msg.messageText === 'string' ? msg.messageText
    : typeof msg.body === 'string' ? msg.body
    : extractGmailBody(msg);
  // Timestamp: Composio gives ISO string; raw Gmail gives ms-as-string
  const ts = msg.messageTimestamp ?? msg.internalDate ?? msg.internal_date;
  return {
    messageId,
    threadId: msg.threadId ?? msg.thread_id ?? null,
    from: typeof msg.sender === 'string' ? msg.sender
      : typeof msg.from === 'string' ? msg.from
      : headers['from'] ?? null,
    to: toList,
    cc: ccList,
    subject: typeof msg.subject === 'string' ? msg.subject : headers['subject'] ?? null,
    snippet: snippetStr,
    body: bodyStr,
    labelIds: Array.isArray(msg.labelIds) ? msg.labelIds : [],
    internalDate: msg.internalDate ?? msg.internal_date ?? msg.messageTimestamp ?? null,
    occurredAt: parseGmailTimestamp(ts),
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
  // Three shapes seen in production:
  //   - Gmail raw API: string of milliseconds since epoch ("1714063221000")
  //   - Composio flat: ISO string ("2026-04-24T00:50:54Z")
  //   - Number (defensive): seconds- or ms-since-epoch
  if (value == null) return undefined;
  if (typeof value === 'string') {
    // ISO short-circuit: Date parses these directly
    if (/[T:Z]/.test(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return msOrSecondsToIso(n);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return msOrSecondsToIso(value);
  return undefined;
}

function msOrSecondsToIso(n: number): string | undefined {
  // < 10^12 → seconds (anything else would be after year 33000); scale up
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
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

function mapSlackMessage(msg: any): raw.SlackMessageInput | null {
  if (!msg || typeof msg !== 'object') return null;
  const ts = String(msg.ts ?? msg.timestamp ?? '').trim();
  // Slack search nests channel under .channel.{id,name}; raw API has channel as a string
  const channelObj = msg.channel;
  const channelId = String(
    (channelObj && typeof channelObj === 'object' ? channelObj.id : channelObj) ?? msg.channel_id ?? '',
  ).trim();
  const channelName = (channelObj && typeof channelObj === 'object')
    ? channelObj.name ?? null : null;
  if (!ts || !channelId) return null;
  // user nested similarly
  const userObj = msg.user;
  const userId = (userObj && typeof userObj === 'object') ? userObj.id ?? null
    : (typeof userObj === 'string' ? userObj : null);
  const userName = (userObj && typeof userObj === 'object')
    ? userObj.name ?? userObj.real_name ?? null
    : msg.username ?? null;
  return {
    channelId,
    channelName: channelName ?? null,
    ts,
    threadTs: msg.thread_ts ?? null,
    userId,
    userName,
    text: typeof msg.text === 'string' ? msg.text : null,
    permalink: msg.permalink ?? null,
  };
}

function mapNotionPage(page: any): raw.NotionPageInput | null {
  if (!page || typeof page !== 'object') return null;
  const pageId = String(page.id ?? page.page_id ?? '').trim();
  if (!pageId) return null;
  // Composio's NOTION_FETCH_DATA returns a slim shape: {id, title, type}
  // — no parent / icon / last_edited_time / properties. The title is a
  // plain string already, not a Notion-API-shaped { properties.title.title[]
  // .plain_text } structure.
  // Raw Notion API (test fixtures, future direct calls) uses the rich
  // shape; extractNotionTitle still handles that fallback.
  const title = typeof page.title === 'string' && page.title
    ? page.title
    : extractNotionTitle(page);
  // type ('page' | 'database') maps to parent_type for filtering downstream.
  // Real parent (workspace/page_id/database_id) would need a per-page fetch.
  const parent = page.parent ?? {};
  const parentType = parent.type ?? (typeof page.type === 'string' ? page.type : null);
  const parentId = parent.page_id ?? parent.database_id ?? null;
  const iconNode = page.icon;
  const icon = iconNode?.emoji ?? iconNode?.external?.url ?? iconNode?.file?.url ?? null;
  return {
    pageId,
    title,
    url: page.url ?? null,
    parentId,
    parentType,
    icon,
    lastEditedTime: page.last_edited_time ?? null,
    createdTime: page.created_time ?? null,
    contentPreview: typeof page.content_preview === 'string' ? page.content_preview : null,
    archived: Boolean(page.archived),
  };
}

function extractNotionTitle(page: any): string | null {
  // Try common title locations in order
  const props = page.properties;
  if (props && typeof props === 'object') {
    for (const key of ['title', 'Title', 'Name', 'name']) {
      const prop = props[key];
      const arr = prop?.title;
      if (Array.isArray(arr) && arr[0]?.plain_text) {
        return String(arr[0].plain_text).trim() || null;
      }
    }
  }
  if (typeof page.title === 'string') return page.title;
  return null;
}

function mapGithubIssue(issue: any): raw.GithubIssueInput | null {
  if (!issue || typeof issue !== 'object') return null;
  // GitHub's stable id is `id` (number); we cast to string for storage.
  const issueId = String(issue.id ?? issue.issue_id ?? '').trim();
  if (!issueId) return null;
  // repo_full_name comes either via `repository_url` (.../owner/repo) or
  // a nested .repository.full_name. Walk both.
  let repoFullName: string | null = null;
  if (typeof issue.repository_url === 'string') {
    const match = issue.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
    if (match) repoFullName = match[1];
  }
  if (!repoFullName && issue.repository?.full_name) {
    repoFullName = String(issue.repository.full_name);
  }
  // body can be huge; cap to a preview
  const bodyPreview = typeof issue.body === 'string' ? issue.body.slice(0, 800) : null;
  // labels: GitHub sends [{name: 'bug', ...}, ...] but sometimes just strings
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l: any) => typeof l === 'string' ? l : (l?.name ?? null)).filter((s: any): s is string => typeof s === 'string')
    : [];
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((a: any) => a?.login ?? null).filter((s: any): s is string => typeof s === 'string')
    : [];
  return {
    issueId,
    number: typeof issue.number === 'number' ? issue.number : null,
    repoFullName,
    title: typeof issue.title === 'string' ? issue.title : null,
    bodyPreview,
    state: typeof issue.state === 'string' ? issue.state : null,
    htmlUrl: typeof issue.html_url === 'string' ? issue.html_url : null,
    isPullRequest: !!issue.pull_request,
    labels,
    assignees,
    createdAtRemote: issue.created_at ?? null,
    updatedAtRemote: issue.updated_at ?? null,
  };
}

function mapOutlookMessage(msg: any): raw.OutlookMessageInput | null {
  if (!msg || typeof msg !== 'object') return null;
  // Graph's id is an opaque string. Some Composio variants alias it.
  const messageId = String(msg.id ?? msg.message_id ?? '').trim();
  if (!messageId) return null;
  const fromAddr = msg.from?.emailAddress?.address ?? msg.from ?? null;
  const toRecipients = Array.isArray(msg.toRecipients)
    ? msg.toRecipients.map((r: any) => r?.emailAddress?.address ?? null).filter((s: any): s is string => typeof s === 'string')
    : [];
  const ccRecipients = Array.isArray(msg.ccRecipients)
    ? msg.ccRecipients.map((r: any) => r?.emailAddress?.address ?? null).filter((s: any): s is string => typeof s === 'string')
    : [];
  // bodyPreview is Graph's pre-rendered preview; body.content is full HTML
  const bodyPreview = typeof msg.bodyPreview === 'string'
    ? msg.bodyPreview
    : (typeof msg.body?.content === 'string' ? msg.body.content.slice(0, 800) : null);
  return {
    messageId,
    conversationId: msg.conversationId ?? null,
    from: typeof fromAddr === 'string' ? fromAddr : null,
    to: toRecipients,
    cc: ccRecipients,
    subject: typeof msg.subject === 'string' ? msg.subject : null,
    bodyPreview,
    receivedAt: msg.receivedDateTime ?? msg.received_at ?? null,
    importance: typeof msg.importance === 'string' ? msg.importance.toLowerCase() : null,
    hasAttachments: Boolean(msg.hasAttachments),
    webLink: typeof msg.webLink === 'string' ? msg.webLink : null,
  };
}

function mapGdriveFile(file: any): raw.GdriveFileInput | null {
  if (!file || typeof file !== 'object') return null;
  const fileId = String(file.id ?? file.file_id ?? '').trim();
  if (!fileId) return null;
  const owners = Array.isArray(file.owners)
    ? file.owners
        .map((o: any) => o?.emailAddress ?? o?.displayName ?? null)
        .filter((s: any): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const sizeRaw = file.size;
  const sizeBytes = typeof sizeRaw === 'number' ? sizeRaw
    : typeof sizeRaw === 'string' && /^\d+$/.test(sizeRaw) ? Number.parseInt(sizeRaw, 10)
    : null;
  return {
    fileId,
    name: file.name ?? null,
    mimeType: file.mimeType ?? file.mime_type ?? null,
    modifiedTime: file.modifiedTime ?? file.modified_time ?? null,
    createdTime: file.createdTime ?? file.created_time ?? null,
    sizeBytes,
    webViewLink: file.webViewLink ?? file.web_view_link ?? null,
    owners,
    trashed: Boolean(file.trashed),
  };
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
    slackRows: raw.SlackMessageInput[];
    slackIds: string[];
    notionRows: raw.NotionPageInput[];
    notionIds: string[];
    gdriveRows: raw.GdriveFileInput[];
    gdriveIds: string[];
    githubRows: raw.GithubIssueInput[];
    githubIds: string[];
    outlookRows: raw.OutlookMessageInput[];
    outlookIds: string[];
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
  for (let i = 0; i < buckets.slackIds.length; i += 1) {
    const row = buckets.slackRows[i];
    if (!row) continue;
    const channelLabel = row.channelName ?? row.channelId;
    const userLabel = row.userName ?? row.userId ?? 'unknown user';
    const title = trimSummary(`#${channelLabel} · ${userLabel}`, 120);
    const summary = trimSummary(row.text ?? title, 280) || title;
    out.push({
      kind: 'connector.slack.message',
      title,
      summary,
      payload: { channelId: row.channelId, threadTs: row.threadTs, userId: row.userId },
      source: `connector:${toolkit}`,
      sourceRawTable: 'slack_messages',
      sourceRawIds: [buckets.slackIds[i]!],
      occurredAt: row.occurredAt,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.channelId}:${row.ts}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.notionIds.length; i += 1) {
    const row = buckets.notionRows[i];
    if (!row) continue;
    const title = trimSummary(row.title ?? '(untitled page)', 120);
    const summary = trimSummary(row.contentPreview ?? row.url ?? title, 280) || title;
    out.push({
      kind: 'connector.notion.page',
      title,
      summary,
      payload: { url: row.url, parentType: row.parentType, parentId: row.parentId },
      source: `connector:${toolkit}`,
      sourceRawTable: 'notion_pages',
      sourceRawIds: [buckets.notionIds[i]!],
      occurredAt: row.lastEditedTime ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.pageId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.gdriveIds.length; i += 1) {
    const row = buckets.gdriveRows[i];
    if (!row) continue;
    const title = trimSummary(row.name ?? '(unnamed file)', 120);
    const mime = row.mimeType ? trimSummary(row.mimeType, 120) : '';
    const summary = trimSummary([mime, row.webViewLink].filter(Boolean).join(' · ') || title, 280) || title;
    out.push({
      kind: 'connector.googledrive.file',
      title,
      summary,
      payload: { mimeType: row.mimeType, webViewLink: row.webViewLink, owners: row.owners },
      source: `connector:${toolkit}`,
      sourceRawTable: 'gdrive_files',
      sourceRawIds: [buckets.gdriveIds[i]!],
      occurredAt: row.modifiedTime ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.fileId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.githubIds.length; i += 1) {
    const row = buckets.githubRows[i];
    if (!row) continue;
    const repoLabel = row.repoFullName ?? 'unknown';
    const numberLabel = typeof row.number === 'number' ? `#${row.number}` : '';
    const kindWord = row.isPullRequest ? 'PR' : 'Issue';
    const title = trimSummary(`${kindWord} ${numberLabel} · ${row.title ?? '(untitled)'} (${repoLabel})`, 120);
    const summary = trimSummary(row.bodyPreview ?? row.htmlUrl ?? title, 280) || title;
    out.push({
      kind: row.isPullRequest ? 'connector.github.pr' : 'connector.github.issue',
      title,
      summary,
      payload: {
        repo: row.repoFullName, number: row.number, state: row.state,
        htmlUrl: row.htmlUrl, labels: row.labels, assignees: row.assignees,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'github_issues',
      sourceRawIds: [buckets.githubIds[i]!],
      occurredAt: row.updatedAtRemote ?? row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.issueId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.outlookIds.length; i += 1) {
    const row = buckets.outlookRows[i];
    if (!row) continue;
    const title = trimSummary(row.subject ?? row.bodyPreview ?? '(no subject)', 120);
    const summary = trimSummary(row.bodyPreview ?? row.subject ?? title, 280) || title;
    out.push({
      kind: 'connector.outlook.message',
      title,
      summary,
      payload: {
        from: row.from, conversationId: row.conversationId,
        importance: row.importance, hasAttachments: row.hasAttachments,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'outlook_messages',
      sourceRawIds: [buckets.outlookIds[i]!],
      occurredAt: row.receivedAt ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.messageId}:init:v1`,
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
    const data = text.trim() ? safeJsonParse(text) : null;
    if (!response.ok) {
      // Composio surfaces errors in a few shapes: {message:'...'},
      // {error:'...'}, {error:{message:'...'}}, {detail:[...]}. Walk
      // them, then fall through to the raw text. JSON.stringify the
      // object so we don't print "[object Object]".
      const msg = formatComposioError(data) ?? text.slice(0, 400);
      throw new Error(`Composio API ${response.status}: ${msg}`);
    }
    return data ?? {};
  };
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try sanitized */ }
  // Composio returns email/document content with raw unescaped control
  // chars inside string literals (verified live: Gmail responses at
  // limit=100 contain unescaped \n, \r, and \x00-\x1F bytes inside
  // message body content). JSON spec requires these to be \-escaped
  // inside strings, so JSON.parse rejects the whole payload. We can't
  // surgically escape them (we don't know which bytes are inside string
  // values vs. whitespace between tokens), so we replace the entire
  // 0x00-0x1F range with spaces. Loses newline structure inside
  // body content but keeps the message readable.
  const sanitized = text.replace(/[\x00-\x1F]/g, ' ');
  try { return JSON.parse(sanitized); } catch { return null; }
}

function formatComposioError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.message === 'string') return d.message;
  if (typeof d.error === 'string') return d.error;
  if (d.error && typeof d.error === 'object') {
    const inner = d.error as Record<string, unknown>;
    if (typeof inner.message === 'string') return inner.message;
  }
  if (typeof d.detail === 'string') return d.detail;
  // Fallback: stringify (capped) so the operator at least sees the shape.
  try { return JSON.stringify(d).slice(0, 400); } catch { return null; }
}
