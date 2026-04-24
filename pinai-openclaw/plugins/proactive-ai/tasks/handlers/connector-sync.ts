/**
 * connector.sync handler — incremental counterpart to connector.init.
 *
 * Init pulls the most recent N items the first time an account turns ACTIVE.
 * Sync periodically (default every 12h, see CONNECTOR_SYNC_INTERVAL_MS)
 * pulls only what's new since the last successful sync, writing to the same
 * raw.db tables and personal_signals — keeps everything fresh without daily
 * full re-pulls. Card generation just reads the latest state, no coupling.
 *
 * Sharing with init:
 *   - reuses the same raw row mappers, signal builder, and Composio fetcher
 *     plumbing exported from connector-init.ts (no duplication of toolkit
 *     parsing logic).
 *   - signals deliberately use init's :init:v1 dedupe key suffix so a row
 *     pulled by both init and sync deduplicates correctly. The suffix is a
 *     stable version marker, not an "init only" tag.
 *
 * Idempotency:
 *   key = `connector.sync:<toolkit>:<accountId>:<windowStart>` where
 *   windowStart = floor(now / interval) * interval. Two enqueuer fires in
 *   the same window collide on the unique key — the second is a no-op.
 *
 * Cursor (connector_sync_cursors table):
 *   On success the handler writes last_synced_at = startedAt. The next sync
 *   uses that as the lower bound for its `since`/`after` query. On failure
 *   the cursor is untouched, so the next attempt re-pulls the same window
 *   (safe — raw.db.dedupe_key + personal_signals.dedupe_key absorb dupes).
 *
 * Discord is supported by init (snapshot of guild list) but has no
 * meaningful incremental semantic, so sync skips it explicitly.
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
  type ComposioFetcher,
  type SupportedToolkit,
  isSupportedToolkit,
  makeDefaultFetcher,
  buildSignalsForInit,
  failHard,
  abortLeaseLost,
  extractGmailMessages, mapGmailMessage,
  extractGcalEvents, mapGcalEvent,
  extractSlackMessages, mapSlackMessage,
  extractNotionPages, mapNotionPage,
  extractGdriveFiles, mapGdriveFile,
  extractGithubIssues, mapGithubIssue,
  extractOutlookMessages, mapOutlookMessage,
  extractGdocsDocuments, mapGdocsDocument,
  extractGsheetsSpreadsheets, mapGsheetsSpreadsheet,
  extractStripeInvoices, mapStripeInvoice,
} from './connector-init.js';
import {
  runConnectorEvolve,
  type AgentRunFn,
  type ConnectorEvolveResult,
} from './connector-evolve.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// When no cursor exists for this account yet (first sync after init), look
// back this far for the initial pull. Init already grabbed the most recent
// 100 items so overlap is fine — raw + signal dedupe absorbs it.
const BOOTSTRAP_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ConnectorSyncPayload {
  toolkit: string;
  connectedAccountId: string;
  /** Items to pull. Clamped to [1, 500]. */
  limit?: number;
  /** Free-form audit label (e.g. 'enqueuer', 'manual'). */
  reason?: string;
}

export interface ConnectorSyncDeps {
  /** When omitted, built lazily from requireComposioApiKey(). */
  fetcher?: ComposioFetcher;
  /** Test override for Composio user_id. */
  userId?: string;
  /** OpenClaw plugin API used by the evolve agent. */
  api?: OpenClawPluginApi;
  /** Timeout for the evolve agent call. Default 60_000 ms. */
  evolveTimeoutMs?: number;
  /** Test hook bypassing api/runAgent. */
  evolveAgentRun?: AgentRunFn;
}

export interface ConnectorSyncResult {
  toolkit: string;
  rawInserted: number;
  rawIgnored: number;
  signalsInserted: number;
  evolutionRunId: string | null;
  memoriesWritten: number;
  /** ISO lower bound used for this sync's `since`/`after` query. */
  sinceUsed: string;
  /** ISO timestamp written to the cursor on success (== task start time). */
  syncedThrough: string;
  evolveError?: string;
  reason?: string;
}

export function createConnectorSyncHandler(deps: ConnectorSyncDeps = {}): TaskHandler {
  return async (ctx) => {
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    const payload = ctx.task.payload as unknown as ConnectorSyncPayload;

    // ── 1. Validate payload ──
    if (!payload?.toolkit || typeof payload.toolkit !== 'string') {
      return failHard('invalid_payload', 'missing toolkit');
    }
    if (!payload?.connectedAccountId || typeof payload.connectedAccountId !== 'string') {
      return failHard('invalid_payload', 'missing connectedAccountId');
    }

    const toolkit = payload.toolkit.toLowerCase();
    const limit = clampLimit(payload.limit);

    // ── 2. Kill switch ──
    if (parseSyncDisabledToolkits().has(toolkit)) {
      return { status: 'skipped', result: { toolkit, reason: 'toolkit_disabled' } };
    }

    // ── 3. Toolkit support ──
    if (!isSupportedToolkit(toolkit)) {
      return { status: 'skipped', result: { toolkit, reason: 'unsupported_toolkit_v0' } };
    }
    if (!supportsIncrementalSync(toolkit)) {
      // Discord is the only one — guild list snapshot, no meaningful "since".
      return { status: 'skipped', result: { toolkit, reason: 'no_incremental_sync_v0' } };
    }

    // ── 4. Resolve fetcher ──
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

    // ── 5. Read cursor → since ──
    const cursor = await db.getConnectorSyncCursor(toolkit, payload.connectedAccountId);
    const since = cursor
      ? new Date(cursor.last_synced_at)
      : new Date(startedAt.getTime() - BOOTSTRAP_LOOKBACK_MS);

    if (!(await ctx.heartbeat({ stage: 'fetch', toolkit, since: since.toISOString(), limit }))) {
      return abortLeaseLost('fetch');
    }

    // ── 6. Per-toolkit cursor-bound fetch ──
    let typedItems: TypedFetchedItems;
    try {
      typedItems = await fetchToolkitItemsSince(toolkit, {
        fetcher, userId,
        connectedAccountId: payload.connectedAccountId,
        limit, since,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', errorCode: 'composio_fetch_failed', errorMessage: msg };
    }

    // ── 7. Ingest raw (raw.db dedupe_key absorbs overlap with init/prior sync) ──
    if (!(await ctx.heartbeat({ stage: 'raw', toolkit }))) {
      return abortLeaseLost('raw');
    }

    let rawInserted = 0;
    let rawIgnored = 0;
    const insertedRawIds: InsertedRawIds = emptyInsertedIds();

    if (typedItems.gmail?.length) {
      const r = raw.ingestGmailMessages(typedItems.gmail);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gmail = r.ids;
    }
    if (typedItems.gcal?.length) {
      const r = raw.ingestGcalEvents(typedItems.gcal);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gcal = r.ids;
    }
    if (typedItems.slack?.length) {
      const r = raw.ingestSlackMessages(typedItems.slack);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.slack = r.ids;
    }
    if (typedItems.notion?.length) {
      const r = raw.ingestNotionPages(typedItems.notion);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.notion = r.ids;
    }
    if (typedItems.gdrive?.length) {
      const r = raw.ingestGdriveFiles(typedItems.gdrive);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gdrive = r.ids;
    }
    if (typedItems.github?.length) {
      const r = raw.ingestGithubIssues(typedItems.github);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.github = r.ids;
    }
    if (typedItems.outlook?.length) {
      const r = raw.ingestOutlookMessages(typedItems.outlook);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.outlook = r.ids;
    }
    if (typedItems.gdocs?.length) {
      const r = raw.ingestGdocsDocuments(typedItems.gdocs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gdocs = r.ids;
    }
    if (typedItems.gsheets?.length) {
      const r = raw.ingestGsheetsSpreadsheets(typedItems.gsheets);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gsheets = r.ids;
    }
    if (typedItems.stripe?.length) {
      const r = raw.ingestStripeInvoices(typedItems.stripe);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.stripe = r.ids;
    }

    // ── 8. Derive personal_signals (reuses init's builder; :init:v1 suffix
    //       in dedupeKey keeps init/sync rows from doubling) ──
    if (!(await ctx.heartbeat({ stage: 'signals', toolkit, rawInserted }))) {
      return abortLeaseLost('signals');
    }

    const signalInputs = buildSignalsForInit(toolkit, payload.connectedAccountId, {
      gmailRows: typedItems.gmail ?? [],     gmailIds: insertedRawIds.gmail,
      gcalRows: typedItems.gcal ?? [],       gcalIds: insertedRawIds.gcal,
      slackRows: typedItems.slack ?? [],     slackIds: insertedRawIds.slack,
      notionRows: typedItems.notion ?? [],   notionIds: insertedRawIds.notion,
      gdriveRows: typedItems.gdrive ?? [],   gdriveIds: insertedRawIds.gdrive,
      githubRows: typedItems.github ?? [],   githubIds: insertedRawIds.github,
      outlookRows: typedItems.outlook ?? [], outlookIds: insertedRawIds.outlook,
      gdocsRows: typedItems.gdocs ?? [],     gdocsIds: insertedRawIds.gdocs,
      gsheetsRows: typedItems.gsheets ?? [], gsheetsIds: insertedRawIds.gsheets,
      stripeRows: typedItems.stripe ?? [],   stripeIds: insertedRawIds.stripe,
      discordRows: [],                       discordIds: [],
    });
    const signalsRes = await db.ingestPersonalSignals(signalInputs);

    // ── 9. Open evolution_run + record refs ──
    if (!(await ctx.heartbeat({ stage: 'evolve', toolkit, signalsInserted: signalsRes.inserted }))) {
      return abortLeaseLost('evolve');
    }

    let evolutionRunId: string | null = null;
    let evolveResult: ConnectorEvolveResult | null = null;
    try {
      const evo = await db.createEvolutionRun({
        triggerKind: 'on_event',
        contextSummary: `connector.sync ${toolkit}: ${rawInserted} raw, ${signalsRes.inserted} signals (${payload.reason ?? 'enqueue'})`,
      });
      evolutionRunId = evo.id;

      const refs: Array<[string, string[]]> = [
        ['gmail_messages',       insertedRawIds.gmail],
        ['gcal_events',          insertedRawIds.gcal],
        ['slack_messages',       insertedRawIds.slack],
        ['notion_pages',         insertedRawIds.notion],
        ['gdrive_files',         insertedRawIds.gdrive],
        ['github_issues',        insertedRawIds.github],
        ['outlook_messages',     insertedRawIds.outlook],
        ['gdocs_documents',      insertedRawIds.gdocs],
        ['gsheets_spreadsheets', insertedRawIds.gsheets],
        ['stripe_invoices',      insertedRawIds.stripe],
      ];
      for (const [table, ids] of refs) {
        if (ids.length > 0) {
          await db.recordEvolutionRefsConsumed(evo.id, table, ids);
        }
      }
      if (signalsRes.ids.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'personal_signals', signalsRes.ids);
      }

      // Optional evolve pass — only when there's actually new data to look at,
      // otherwise burn an LLM call on nothing.
      const hasNewData = rawInserted > 0 || signalsRes.inserted > 0;
      if (hasNewData && (deps.api || deps.evolveAgentRun)) {
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
            gdocs: typedItems.gdocs,
            gsheets: typedItems.gsheets,
            stripe: typedItems.stripe,
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
        await db.completeEvolutionRun(evo.id, { durationMs: evolveResult?.durationMs });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`[connector.sync] evolution bookkeeping failed: ${msg}`);
    }

    // ── 10. Persist cursor (only on success path; failures left it untouched) ──
    await db.upsertConnectorSyncCursor({
      toolkit,
      connectedAccountId: payload.connectedAccountId,
      lastSyncedAt: startedIso,
    });

    const result: ConnectorSyncResult = {
      toolkit,
      rawInserted,
      rawIgnored,
      signalsInserted: signalsRes.inserted,
      evolutionRunId,
      memoriesWritten: evolveResult?.memoriesWritten ?? 0,
      sinceUsed: since.toISOString(),
      syncedThrough: startedIso,
      ...(evolveResult?.llmFailed && evolveResult.llmError
        ? { evolveError: evolveResult.llmError }
        : {}),
      reason: payload.reason,
    };
    return { status: 'succeeded', result: result as unknown as Record<string, unknown> };
  };
}

// ──────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────

interface TypedFetchedItems {
  gmail?: raw.GmailMessageInput[];
  gcal?: raw.GcalEventInput[];
  slack?: raw.SlackMessageInput[];
  notion?: raw.NotionPageInput[];
  gdrive?: raw.GdriveFileInput[];
  github?: raw.GithubIssueInput[];
  outlook?: raw.OutlookMessageInput[];
  gdocs?: raw.GdocsDocumentInput[];
  gsheets?: raw.GsheetsSpreadsheetInput[];
  stripe?: raw.StripeInvoiceInput[];
}

interface InsertedRawIds {
  gmail: string[]; gcal: string[]; slack: string[]; notion: string[];
  gdrive: string[]; github: string[]; outlook: string[]; gdocs: string[];
  gsheets: string[]; stripe: string[];
}

interface FetchSinceOpts {
  fetcher: ComposioFetcher;
  userId: string;
  connectedAccountId: string;
  limit: number;
  since: Date;
}

function emptyInsertedIds(): InsertedRawIds {
  return {
    gmail: [], gcal: [], slack: [], notion: [], gdrive: [],
    github: [], outlook: [], gdocs: [], gsheets: [], stripe: [],
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseSyncDisabledToolkits(): Set<string> {
  const value = process.env.CONNECTOR_SYNC_DISABLED_TOOLKITS;
  if (!value) return new Set();
  return new Set(value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * Discord's only Composio action is a guild-list snapshot — no meaningful
 * incremental semantic. We let init populate it once and skip subsequent
 * sync passes; reconciler will keep init working.
 */
function supportsIncrementalSync(toolkit: SupportedToolkit | string): boolean {
  return toolkit !== 'discord';
}

// ──────────────────────────────────────────────────────────────────────
// Per-toolkit cursor-bound fetchers
// ──────────────────────────────────────────────────────────────────────

async function fetchToolkitItemsSince(
  toolkit: SupportedToolkit,
  opts: FetchSinceOpts,
): Promise<TypedFetchedItems> {
  switch (toolkit) {
    case 'gmail':          return { gmail:   await fetchGmailSince(opts) };
    case 'googlecalendar': return { gcal:    await fetchGcalSince(opts) };
    case 'slack':          return { slack:   await fetchSlackSince(opts) };
    case 'notion':         return { notion:  await fetchNotionSince(opts) };
    case 'googledrive':    return { gdrive:  await fetchGdriveSince(opts) };
    case 'github':         return { github:  await fetchGithubSince(opts) };
    case 'outlook':        return { outlook: await fetchOutlookSince(opts) };
    case 'googledocs':     return { gdocs:   await fetchGdocsSince(opts) };
    case 'googlesheets':   return { gsheets: await fetchGsheetsSince(opts) };
    case 'stripe':         return { stripe:  await fetchStripeSince(opts) };
    case 'discord':        return {}; // already screened by supportsIncrementalSync
    default:               return {};
  }
}

async function fetchGmailSince(opts: FetchSinceOpts): Promise<raw.GmailMessageInput[]> {
  // Gmail search syntax accepts `after:<unix_seconds>` for precise filtering.
  // verbose=false + include_payload=true mirrors init's setup so 100 msgs fit.
  const sinceSec = Math.floor(opts.since.getTime() / 1000);
  const response = await opts.fetcher('/tools/execute/GMAIL_FETCH_EMAILS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        verbose: false,
        include_payload: true,
        query: `after:${sinceSec}`,
      },
    }),
  });
  return extractGmailMessages(response)
    .map(mapGmailMessage)
    .filter((m): m is raw.GmailMessageInput => !!m?.messageId);
}

async function fetchGcalSince(opts: FetchSinceOpts): Promise<raw.GcalEventInput[]> {
  // updatedMin returns events created or modified after that time. Drop
  // timeMax — sync wants whatever changed, including events scheduled
  // arbitrarily far in the future. singleEvents=true expands recurring.
  const response = await opts.fetcher('/tools/execute/GOOGLECALENDAR_EVENTS_LIST', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        calendarId: 'primary',
        updatedMin: opts.since.toISOString(),
        singleEvents: true,
        maxResults: opts.limit,
      },
    }),
  });
  return extractGcalEvents(response)
    .map(mapGcalEvent)
    .filter((e): e is raw.GcalEventInput => !!e?.eventId && !!e?.calendarId)
    .slice(0, opts.limit);
}

async function fetchSlackSince(opts: FetchSinceOpts): Promise<raw.SlackMessageInput[]> {
  // Slack search supports `after:YYYY-MM-DD` (date granularity only).
  // Subtract one day so we don't miss messages on the boundary day —
  // overlap is fine, raw + signal dedupe absorbs it.
  const cutoff = new Date(opts.since.getTime() - 86_400_000);
  const dateStr = cutoff.toISOString().slice(0, 10);
  const response = await opts.fetcher('/tools/execute/SLACK_SEARCH_MESSAGES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        query: `after:${dateStr}`,
        count: opts.limit,
        sort: 'timestamp',
        sort_dir: 'desc',
        include_bots: false,
      },
    }),
  });
  return extractSlackMessages(response)
    .map(mapSlackMessage)
    .filter((m): m is raw.SlackMessageInput => !!m?.channelId && !!m?.ts)
    .slice(0, opts.limit);
}

async function fetchNotionSince(opts: FetchSinceOpts): Promise<raw.NotionPageInput[]> {
  // NOTION_FETCH_DATA has no native time filter. Pull a page and filter
  // client-side by lastEditedTime >= since. Notion's slim shape sometimes
  // omits last_edited_time → keep those (raw dedupe will catch dupes).
  const response = await opts.fetcher('/tools/execute/NOTION_FETCH_DATA', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { get_pages: true, page_size: opts.limit },
    }),
  });
  const all = extractNotionPages(response)
    .map(mapNotionPage)
    .filter((p): p is raw.NotionPageInput => !!p?.pageId);
  const sinceMs = opts.since.getTime();
  return all
    .filter((p) => {
      if (!p.lastEditedTime) return true;
      const t = Date.parse(p.lastEditedTime);
      return Number.isFinite(t) ? t >= sinceMs : true;
    })
    .slice(0, opts.limit);
}

async function fetchGdriveSince(opts: FetchSinceOpts): Promise<raw.GdriveFileInput[]> {
  // Drive's q syntax is the cleanest form of "since".
  const sinceIso = opts.since.toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLEDRIVE_FIND_FILE', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        q: `modifiedTime > '${sinceIso}' and trashed = false`,
        page_size: opts.limit,
        spaces: 'drive',
        corpora: 'user',
      },
    }),
  });
  return extractGdriveFiles(response)
    .map(mapGdriveFile)
    .filter((f): f is raw.GdriveFileInput => !!f?.fileId)
    .slice(0, opts.limit);
}

async function fetchGithubSince(opts: FetchSinceOpts): Promise<raw.GithubIssueInput[]> {
  // GitHub's `since` ISO arg is already in init; sync just plugs in the
  // cursor instead of init's hard-coded 90-day window.
  const response = await opts.fetcher('/tools/execute/GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        since: opts.since.toISOString(),
        state: 'all',
        filter: 'assigned',
        per_page: opts.limit,
        direction: 'desc',
      },
    }),
  });
  return extractGithubIssues(response)
    .map(mapGithubIssue)
    .filter((i): i is raw.GithubIssueInput => !!i?.issueId)
    .slice(0, opts.limit);
}

async function fetchOutlookSince(opts: FetchSinceOpts): Promise<raw.OutlookMessageInput[]> {
  // Microsoft Graph $filter syntax: receivedDateTime ge yyyy-MM-ddTHH:mm:ssZ.
  const filter = `receivedDateTime ge ${opts.since.toISOString()}`;
  const response = await opts.fetcher('/tools/execute/OUTLOOK_LIST_MESSAGES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        top: opts.limit,
        orderby: 'receivedDateTime desc',
        filter,
      },
    }),
  });
  return extractOutlookMessages(response)
    .map(mapOutlookMessage)
    .filter((m): m is raw.OutlookMessageInput => !!m?.messageId)
    .slice(0, opts.limit);
}

async function fetchGdocsSince(opts: FetchSinceOpts): Promise<raw.GdocsDocumentInput[]> {
  // GOOGLEDOCS_SEARCH_DOCUMENTS uses Drive's search. We pass query for
  // narrowing; client-side filter as defense in depth (in case the action
  // doesn't propagate the q to Drive).
  const sinceIso = opts.since.toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLEDOCS_SEARCH_DOCUMENTS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        order_by: 'modifiedTime desc',
        include_trashed: false,
        query: `modifiedTime > '${sinceIso}'`,
      },
    }),
  });
  const all = extractGdocsDocuments(response)
    .map(mapGdocsDocument)
    .filter((d): d is raw.GdocsDocumentInput => !!d?.documentId);
  const sinceMs = opts.since.getTime();
  return all
    .filter((d) => {
      if (!d.modifiedTime) return true;
      const t = Date.parse(d.modifiedTime);
      return Number.isFinite(t) ? t >= sinceMs : true;
    })
    .slice(0, opts.limit);
}

async function fetchGsheetsSince(opts: FetchSinceOpts): Promise<raw.GsheetsSpreadsheetInput[]> {
  const sinceIso = opts.since.toISOString();
  const response = await opts.fetcher('/tools/execute/GOOGLESHEETS_SEARCH_SPREADSHEETS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        order_by: 'modifiedTime desc',
        include_trashed: false,
        query: `modifiedTime > '${sinceIso}'`,
      },
    }),
  });
  const all = extractGsheetsSpreadsheets(response)
    .map(mapGsheetsSpreadsheet)
    .filter((s): s is raw.GsheetsSpreadsheetInput => !!s?.spreadsheetId);
  const sinceMs = opts.since.getTime();
  return all
    .filter((s) => {
      if (!s.modifiedTime) return true;
      const t = Date.parse(s.modifiedTime);
      return Number.isFinite(t) ? t >= sinceMs : true;
    })
    .slice(0, opts.limit);
}

async function fetchStripeSince(opts: FetchSinceOpts): Promise<raw.StripeInvoiceInput[]> {
  // Stripe standard list: created[gte] = unix seconds.
  const sinceSec = Math.floor(opts.since.getTime() / 1000);
  const response = await opts.fetcher('/tools/execute/STRIPE_LIST_INVOICES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 100),
        created: { gte: sinceSec },
      },
    }),
  });
  return extractStripeInvoices(response)
    .map(mapStripeInvoice)
    .filter((i): i is raw.StripeInvoiceInput => !!i?.invoiceId)
    .slice(0, opts.limit);
}
