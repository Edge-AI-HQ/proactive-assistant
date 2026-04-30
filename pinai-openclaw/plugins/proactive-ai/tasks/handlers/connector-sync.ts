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
  extractSpotifyRecentTracks, mapSpotifyRecentTrack,
  extractStravaActivities, mapStravaActivity,
  extractTodoistTasks, mapTodoistTask,
  extractYoutubeSubscriptions, mapYoutubeSubscription,
  extractTrelloBoards, mapTrelloBoard,
  extractJiraProjects, mapJiraProject,
  extractTwitterBookmarks, extractTwitterUserIncludes, mapTwitterBookmark,
  extractCalendlyUserUri, extractCalendlyEvents, mapCalendlyEvent,
  extractLinkedinOrganizations, mapLinkedinProfile, mapLinkedinOrganization,
  mapFigmaUser, mapZoomUser,
  extractZoomMarketplaceApps, mapZoomMarketplaceApp,
  mapDropboxAccount, extractDropboxFiles, mapDropboxFile,
  extractAsanaList, mapAsanaWorkspace, mapAsanaTask,
  extractHubspotContacts, mapHubspotContact,
  mapClickupUser, extractClickupWorkspaces, mapClickupWorkspace,
  unwrapDataPaths,
  isComposioToolNotFound,
  fetchZoomUserViaProxy,
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
  skillsAdded: number;
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
    if (typedItems.spotifyRecent?.length) {
      const r = raw.ingestSpotifyRecentTracks(typedItems.spotifyRecent);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.spotifyRecent = r.ids;
    }
    if (typedItems.stravaActivities?.length) {
      const r = raw.ingestStravaActivities(typedItems.stravaActivities);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.stravaActivities = r.ids;
    }
    if (typedItems.todoistTasks?.length) {
      const r = raw.ingestTodoistTasks(typedItems.todoistTasks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.todoistTasks = r.ids;
    }
    if (typedItems.youtubeSubs?.length) {
      const r = raw.ingestYoutubeSubscriptions(typedItems.youtubeSubs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.youtubeSubs = r.ids;
    }
    if (typedItems.trelloBoards?.length) {
      const r = raw.ingestTrelloBoards(typedItems.trelloBoards);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.trelloBoards = r.ids;
    }
    if (typedItems.jiraProjects?.length) {
      const r = raw.ingestJiraProjects(typedItems.jiraProjects);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.jiraProjects = r.ids;
    }
    if (typedItems.twitterBookmarks?.length) {
      const r = raw.ingestTwitterBookmarks(typedItems.twitterBookmarks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.twitterBookmarks = r.ids;
    }
    if (typedItems.calendlyEvents?.length) {
      const r = raw.ingestCalendlyEvents(typedItems.calendlyEvents);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.calendlyEvents = r.ids;
    }
    if (typedItems.linkedinProfile?.length) {
      const r = raw.ingestLinkedinProfile(typedItems.linkedinProfile);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.linkedinProfile = r.ids;
    }
    if (typedItems.linkedinOrgs?.length) {
      const r = raw.ingestLinkedinOrganizations(typedItems.linkedinOrgs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.linkedinOrgs = r.ids;
    }
    if (typedItems.figmaUser?.length) {
      const r = raw.ingestFigmaUser(typedItems.figmaUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.figmaUser = r.ids;
    }
    if (typedItems.zoomUser?.length) {
      const r = raw.ingestZoomUser(typedItems.zoomUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.zoomUser = r.ids;
    }
    if (typedItems.zoomApps?.length) {
      const r = raw.ingestZoomMarketplaceApps(typedItems.zoomApps);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.zoomApps = r.ids;
    }
    if (typedItems.dropboxAccount?.length) {
      const r = raw.ingestDropboxAccount(typedItems.dropboxAccount);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.dropboxAccount = r.ids;
    }
    if (typedItems.dropboxFiles?.length) {
      const r = raw.ingestDropboxFiles(typedItems.dropboxFiles);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.dropboxFiles = r.ids;
    }
    if (typedItems.asanaWorkspaces?.length) {
      const r = raw.ingestAsanaWorkspaces(typedItems.asanaWorkspaces);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.asanaWorkspaces = r.ids;
    }
    if (typedItems.asanaTasks?.length) {
      const r = raw.ingestAsanaTasks(typedItems.asanaTasks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.asanaTasks = r.ids;
    }
    if (typedItems.hubspotContacts?.length) {
      const r = raw.ingestHubspotContacts(typedItems.hubspotContacts);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.hubspotContacts = r.ids;
    }
    if (typedItems.clickupUser?.length) {
      const r = raw.ingestClickupUser(typedItems.clickupUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.clickupUser = r.ids;
    }
    if (typedItems.clickupWorkspaces?.length) {
      const r = raw.ingestClickupWorkspaces(typedItems.clickupWorkspaces);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.clickupWorkspaces = r.ids;
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
      spotifyRecentRows: typedItems.spotifyRecent ?? [], spotifyRecentIds: insertedRawIds.spotifyRecent,
      stravaRows: typedItems.stravaActivities ?? [], stravaIds: insertedRawIds.stravaActivities,
      todoistRows: typedItems.todoistTasks ?? [], todoistIds: insertedRawIds.todoistTasks,
      youtubeSubsRows: typedItems.youtubeSubs ?? [], youtubeSubsIds: insertedRawIds.youtubeSubs,
      trelloRows: typedItems.trelloBoards ?? [], trelloIds: insertedRawIds.trelloBoards,
      jiraRows: typedItems.jiraProjects ?? [], jiraIds: insertedRawIds.jiraProjects,
      twitterRows: typedItems.twitterBookmarks ?? [], twitterIds: insertedRawIds.twitterBookmarks,
      calendlyRows: typedItems.calendlyEvents ?? [], calendlyIds: insertedRawIds.calendlyEvents,
      linkedinProfileRows: typedItems.linkedinProfile ?? [], linkedinProfileIds: insertedRawIds.linkedinProfile,
      linkedinOrgRows: typedItems.linkedinOrgs ?? [], linkedinOrgIds: insertedRawIds.linkedinOrgs,
      figmaUserRows: typedItems.figmaUser ?? [], figmaUserIds: insertedRawIds.figmaUser,
      zoomUserRows: typedItems.zoomUser ?? [], zoomUserIds: insertedRawIds.zoomUser,
      zoomAppRows: typedItems.zoomApps ?? [], zoomAppIds: insertedRawIds.zoomApps,
      dropboxAccountRows: typedItems.dropboxAccount ?? [], dropboxAccountIds: insertedRawIds.dropboxAccount,
      dropboxFileRows: typedItems.dropboxFiles ?? [], dropboxFileIds: insertedRawIds.dropboxFiles,
      asanaWorkspaceRows: typedItems.asanaWorkspaces ?? [], asanaWorkspaceIds: insertedRawIds.asanaWorkspaces,
      asanaTaskRows: typedItems.asanaTasks ?? [], asanaTaskIds: insertedRawIds.asanaTasks,
      hubspotContactRows: typedItems.hubspotContacts ?? [], hubspotContactIds: insertedRawIds.hubspotContacts,
      clickupUserRows: typedItems.clickupUser ?? [], clickupUserIds: insertedRawIds.clickupUser,
      clickupWorkspaceRows: typedItems.clickupWorkspaces ?? [], clickupWorkspaceIds: insertedRawIds.clickupWorkspaces,
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
        ['spotify_recent_tracks', insertedRawIds.spotifyRecent],
        ['strava_activities',    insertedRawIds.stravaActivities],
        ['todoist_tasks',        insertedRawIds.todoistTasks],
        ['youtube_subscriptions', insertedRawIds.youtubeSubs],
        ['trello_boards',        insertedRawIds.trelloBoards],
        ['jira_projects',        insertedRawIds.jiraProjects],
        ['twitter_bookmarks',    insertedRawIds.twitterBookmarks],
        ['calendly_events',      insertedRawIds.calendlyEvents],
        ['linkedin_profile',     insertedRawIds.linkedinProfile],
        ['linkedin_organizations', insertedRawIds.linkedinOrgs],
        ['figma_user',           insertedRawIds.figmaUser],
        ['zoom_user',            insertedRawIds.zoomUser],
        ['zoom_marketplace_apps', insertedRawIds.zoomApps],
        ['dropbox_account',      insertedRawIds.dropboxAccount],
        ['dropbox_files',        insertedRawIds.dropboxFiles],
        ['asana_workspaces',     insertedRawIds.asanaWorkspaces],
        ['asana_tasks',          insertedRawIds.asanaTasks],
        ['hubspot_contacts',     insertedRawIds.hubspotContacts],
        ['clickup_user',         insertedRawIds.clickupUser],
        ['clickup_workspaces',   insertedRawIds.clickupWorkspaces],
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
            connectedAccountId: payload.connectedAccountId,
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
            spotifyRecent: typedItems.spotifyRecent,
            stravaActivities: typedItems.stravaActivities,
            todoistTasks: typedItems.todoistTasks,
            youtubeSubs: typedItems.youtubeSubs,
            trelloBoards: typedItems.trelloBoards,
            jiraProjects: typedItems.jiraProjects,
            twitterBookmarks: typedItems.twitterBookmarks,
            calendlyEvents: typedItems.calendlyEvents,
            linkedinProfile: typedItems.linkedinProfile,
            linkedinOrgs: typedItems.linkedinOrgs,
            figmaUser: typedItems.figmaUser,
            zoomUser: typedItems.zoomUser,
            zoomApps: typedItems.zoomApps,
            dropboxAccount: typedItems.dropboxAccount,
            dropboxFiles: typedItems.dropboxFiles,
            asanaWorkspaces: typedItems.asanaWorkspaces,
            asanaTasks: typedItems.asanaTasks,
            hubspotContacts: typedItems.hubspotContacts,
            clickupUser: typedItems.clickupUser,
            clickupWorkspaces: typedItems.clickupWorkspaces,
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
      skillsAdded: evolveResult?.skillsAdded ?? 0,
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
  spotifyRecent?: raw.SpotifyRecentTrackInput[];
  stravaActivities?: raw.StravaActivityInput[];
  todoistTasks?: raw.TodoistTaskInput[];
  youtubeSubs?: raw.YoutubeSubscriptionInput[];
  trelloBoards?: raw.TrelloBoardInput[];
  jiraProjects?: raw.JiraProjectInput[];
  twitterBookmarks?: raw.TwitterBookmarkInput[];
  calendlyEvents?: raw.CalendlyEventInput[];
  linkedinProfile?: raw.LinkedinProfileInput[];
  linkedinOrgs?: raw.LinkedinOrganizationInput[];
  figmaUser?: raw.FigmaUserInput[];
  zoomUser?: raw.ZoomUserInput[];
  zoomApps?: raw.ZoomMarketplaceAppInput[];
  dropboxAccount?: raw.DropboxAccountInput[];
  dropboxFiles?: raw.DropboxFileInput[];
  asanaWorkspaces?: raw.AsanaWorkspaceInput[];
  asanaTasks?: raw.AsanaTaskInput[];
  hubspotContacts?: raw.HubspotContactInput[];
  clickupUser?: raw.ClickupUserInput[];
  clickupWorkspaces?: raw.ClickupWorkspaceInput[];
}

interface InsertedRawIds {
  gmail: string[]; gcal: string[]; slack: string[]; notion: string[];
  gdrive: string[]; github: string[]; outlook: string[]; gdocs: string[];
  gsheets: string[]; stripe: string[]; spotifyRecent: string[];
  stravaActivities: string[]; todoistTasks: string[]; youtubeSubs: string[];
  trelloBoards: string[]; jiraProjects: string[];
  twitterBookmarks: string[]; calendlyEvents: string[];
  linkedinProfile: string[]; linkedinOrgs: string[]; figmaUser: string[];
  zoomUser: string[]; zoomApps: string[];
  dropboxAccount: string[]; dropboxFiles: string[];
  asanaWorkspaces: string[]; asanaTasks: string[];
  hubspotContacts: string[];
  clickupUser: string[]; clickupWorkspaces: string[];
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
    spotifyRecent: [],
    stravaActivities: [], todoistTasks: [], youtubeSubs: [],
    trelloBoards: [], jiraProjects: [],
    twitterBookmarks: [], calendlyEvents: [],
    linkedinProfile: [], linkedinOrgs: [], figmaUser: [],
    zoomUser: [], zoomApps: [],
    dropboxAccount: [], dropboxFiles: [],
    asanaWorkspaces: [], asanaTasks: [],
    hubspotContacts: [],
    clickupUser: [], clickupWorkspaces: [],
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
 *
 * Snapshot-style toolkits (todoist tasks, youtube subs, trello boards, jira
 * projects, twitter bookmarks) DO sync — they re-pull the full list and
 * raw.dedupe_key absorbs duplicates. That's how new items get picked up
 * (no clean since-filter on those upstream APIs).
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
    case 'spotify':        return { spotifyRecent: await fetchSpotifyRecentSince(opts) };
    case 'strava':         return { stravaActivities: await fetchStravaSince(opts) };
    case 'todoist':        return { todoistTasks: await fetchTodoistSince(opts) };
    case 'youtube':        return { youtubeSubs: await fetchYoutubeSince(opts) };
    case 'trello':         return { trelloBoards: await fetchTrelloSince(opts) };
    case 'jira':           return { jiraProjects: await fetchJiraSince(opts) };
    case 'twitter':        return { twitterBookmarks: await fetchTwitterSince(opts) };
    case 'calendly':       return { calendlyEvents: await fetchCalendlySince(opts) };
    case 'linkedin': {
      const [profile, orgs] = await Promise.all([
        fetchLinkedinProfileSince(opts), fetchLinkedinOrgsSince(opts),
      ]);
      return { linkedinProfile: profile, linkedinOrgs: orgs };
    }
    case 'figma':          return { figmaUser: await fetchFigmaUserSince(opts) };
    case 'zoom': {
      const [user, apps] = await Promise.all([
        fetchZoomUserSince(opts), fetchZoomAppsSince(opts),
      ]);
      return { zoomUser: user, zoomApps: apps };
    }
    case 'dropbox': {
      const [account, files] = await Promise.all([
        fetchDropboxAccountSince(opts), fetchDropboxFilesSince(opts),
      ]);
      return { dropboxAccount: account, dropboxFiles: files };
    }
    case 'asana': {
      const workspaces = await fetchAsanaWorkspacesSince(opts);
      const tasks = await fetchAsanaTasksSince(opts, workspaces);
      return { asanaWorkspaces: workspaces, asanaTasks: tasks };
    }
    case 'hubspot':        return { hubspotContacts: await fetchHubspotContactsSince(opts) };
    case 'clickup': {
      const [user, workspaces] = await Promise.all([
        fetchClickupUserSince(opts), fetchClickupWorkspacesSince(opts),
      ]);
      return { clickupUser: user, clickupWorkspaces: workspaces };
    }
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
        filter: 'all',
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

async function fetchStravaSince(opts: FetchSinceOpts): Promise<raw.StravaActivityInput[]> {
  // Strava list-activities supports `after` (Unix seconds, exclusive).
  const afterSec = Math.floor(opts.since.getTime() / 1000);
  const response = await opts.fetcher('/tools/execute/STRAVA_LIST_ATHLETE_ACTIVITIES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        per_page: Math.min(opts.limit, 200),
        after: afterSec,
      },
    }),
  });
  return extractStravaActivities(response)
    .map(mapStravaActivity)
    .filter((a): a is raw.StravaActivityInput => !!a?.activityId)
    .slice(0, opts.limit);
}

async function fetchTodoistSince(_opts: FetchSinceOpts): Promise<raw.TodoistTaskInput[]> {
  // Todoist has no native "modified-since" filter on /tasks. Re-pull the
  // full active set; raw.dedupe_key absorbs duplicates so this is cheap on
  // disk. New tasks since last sync naturally land as fresh rows.
  const response = await _opts.fetcher('/tools/execute/TODOIST_GET_ALL_TASKS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: _opts.userId,
      connected_account_id: _opts.connectedAccountId,
      arguments: { limit: Math.min(_opts.limit, 200) },
    }),
  });
  return extractTodoistTasks(response)
    .map(mapTodoistTask)
    .filter((t): t is raw.TodoistTaskInput => !!t?.taskId)
    .slice(0, _opts.limit);
}

async function fetchYoutubeSince(opts: FetchSinceOpts): Promise<raw.YoutubeSubscriptionInput[]> {
  // YouTube subscriptions list has no since filter. Full re-pull; dedupe
  // absorbs. Order by alphabetical (default) is fine for snapshot use.
  const response = await opts.fetcher('/tools/execute/YOUTUBE_LIST_USER_SUBSCRIPTIONS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        mine: true,
        part: 'snippet,contentDetails',
        maxResults: Math.min(opts.limit, 50),
      },
    }),
  });
  return extractYoutubeSubscriptions(response)
    .map(mapYoutubeSubscription)
    .filter((s): s is raw.YoutubeSubscriptionInput => !!s?.subscriptionId && !!s?.channelId)
    .slice(0, opts.limit);
}

async function fetchTrelloSince(opts: FetchSinceOpts): Promise<raw.TrelloBoardInput[]> {
  // Trello boards list has no since filter; we COULD post-filter on
  // dateLastActivity but new boards won't have an old activity date so
  // that breaks first-pull. Just re-pull and dedupe.
  const response = await opts.fetcher('/tools/execute/TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        idMember: 'me',
        fields: 'name,desc,url,closed,starred,pinned,idOrganization,dateLastActivity',
      },
    }),
  });
  return extractTrelloBoards(response)
    .map(mapTrelloBoard)
    .filter((b): b is raw.TrelloBoardInput => !!b?.boardId)
    .slice(0, opts.limit);
}

async function fetchJiraSince(opts: FetchSinceOpts): Promise<raw.JiraProjectInput[]> {
  // Jira recent-projects has no since filter — it's already "recently
  // accessed". Full re-pull is the only mode.
  const response = await opts.fetcher('/tools/execute/JIRA_GET_RECENT_PROJECTS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  return extractJiraProjects(response)
    .map(mapJiraProject)
    .filter((p): p is raw.JiraProjectInput => !!p?.projectId)
    .slice(0, opts.limit);
}

async function fetchTwitterSince(opts: FetchSinceOpts): Promise<raw.TwitterBookmarkInput[]> {
  // Twitter bookmarks endpoint doesn't expose a since-filter; pagination
  // is via pagination_token. Re-pull the most recent page; dedupe absorbs
  // and we'll naturally see new bookmarks.
  const response = await opts.fetcher('/tools/execute/TWITTER_BOOKMARKS_BY_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        id: 'me',
        max_results: Math.min(opts.limit, 100),
        'tweet.fields': 'created_at,lang,author_id',
        expansions: 'author_id',
        'user.fields': 'username,name',
      },
    }),
  });
  const authors = extractTwitterUserIncludes(response);
  return extractTwitterBookmarks(response)
    .map((t) => mapTwitterBookmark(t, authors))
    .filter((b): b is raw.TwitterBookmarkInput => !!b?.tweetId)
    .slice(0, opts.limit);
}

async function fetchCalendlySince(opts: FetchSinceOpts): Promise<raw.CalendlyEventInput[]> {
  // Calendly supports min_start_time on /scheduled_events. Same two-step
  // (resolve user URI first) as init.
  const userResponse = await opts.fetcher('/tools/execute/CALENDLY_GET_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { uuid: 'me' },
    }),
  });
  const userUri = extractCalendlyUserUri(userResponse);
  if (!userUri) return [];
  const response = await opts.fetcher('/tools/execute/CALENDLY_LIST_SCHEDULED_EVENTS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        user: userUri,
        sort: 'start_time:desc',
        count: Math.min(opts.limit, 100),
        min_start_time: opts.since.toISOString(),
      },
    }),
  });
  return extractCalendlyEvents(response)
    .map(mapCalendlyEvent)
    .filter((e): e is raw.CalendlyEventInput => !!e?.eventUri)
    .slice(0, opts.limit);
}

// Snapshot-style refetch for the round 5 toolkits — none of them expose
// a clean since-filter (LinkedIn profile / orgs are stable, Figma user is
// stable, Zoom user/apps are stable, Dropbox files have a cursor-based
// API but for v0 we just re-list root, Asana/HubSpot/ClickUp similar).
// Re-pull on each tick; raw.dedupe_key absorbs and new items naturally
// land as fresh rows.

async function fetchLinkedinProfileSince(opts: FetchSinceOpts): Promise<raw.LinkedinProfileInput[]> {
  const response = await opts.fetcher('/tools/execute/LINKEDIN_GET_MY_INFO', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapLinkedinProfile(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchLinkedinOrgsSince(opts: FetchSinceOpts): Promise<raw.LinkedinOrganizationInput[]> {
  const response = await opts.fetcher('/tools/execute/LINKEDIN_GET_COMPANY_INFO', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: { count: Math.min(opts.limit, 50) },
    }),
  });
  return extractLinkedinOrganizations(response)
    .map(mapLinkedinOrganization)
    .filter((o): o is raw.LinkedinOrganizationInput => !!o?.orgUrn)
    .slice(0, opts.limit);
}

async function fetchFigmaUserSince(opts: FetchSinceOpts): Promise<raw.FigmaUserInput[]> {
  const response = await opts.fetcher('/tools/execute/FIGMA_GET_CURRENT_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapFigmaUser(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchZoomUserSince(opts: FetchSinceOpts): Promise<raw.ZoomUserInput[]> {
  try {
    const response = await opts.fetcher('/tools/execute/ZOOM_GET_USER', {
      method: 'POST',
      body: JSON.stringify({
        user_id: opts.userId, connected_account_id: opts.connectedAccountId,
        arguments: { userId: 'me' },
      }),
    });
    const mapped = mapZoomUser(unwrapDataPaths(response)[0] ?? response);
    return mapped ? [mapped] : [];
  } catch (err) {
    if (isComposioToolNotFound(err, 'ZOOM_GET_USER')) return fetchZoomUserViaProxy(opts);
    throw err;
  }
}

async function fetchZoomAppsSince(opts: FetchSinceOpts): Promise<raw.ZoomMarketplaceAppInput[]> {
  try {
    const response = await opts.fetcher('/tools/execute/ZOOM_GET_MARKETPLACE_USER_APPS', {
      method: 'POST',
      body: JSON.stringify({
        user_id: opts.userId, connected_account_id: opts.connectedAccountId,
        arguments: { id: 'me', page_size: Math.min(opts.limit, 100) },
      }),
    });
    return extractZoomMarketplaceApps(response)
      .map(mapZoomMarketplaceApp)
      .filter((a): a is raw.ZoomMarketplaceAppInput => !!a?.appInstallId)
      .slice(0, opts.limit);
  } catch { return []; }
}

async function fetchDropboxAccountSince(opts: FetchSinceOpts): Promise<raw.DropboxAccountInput[]> {
  const response = await opts.fetcher('/tools/execute/DROPBOX_GET_ABOUT_ME', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapDropboxAccount(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchDropboxFilesSince(opts: FetchSinceOpts): Promise<raw.DropboxFileInput[]> {
  const response = await opts.fetcher('/tools/execute/DROPBOX_LIST_FOLDER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: { path: '', limit: Math.min(opts.limit, 2000) },
    }),
  });
  return extractDropboxFiles(response)
    .map(mapDropboxFile)
    .filter((f): f is raw.DropboxFileInput => !!f?.fileId)
    .slice(0, opts.limit);
}

async function fetchAsanaWorkspacesSince(opts: FetchSinceOpts): Promise<raw.AsanaWorkspaceInput[]> {
  const response = await opts.fetcher('/tools/execute/ASANA_GET_WORKSPACES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: { limit: 100 },
    }),
  });
  return extractAsanaList(response)
    .map(mapAsanaWorkspace)
    .filter((w): w is raw.AsanaWorkspaceInput => !!w?.workspaceGid);
}

async function fetchAsanaTasksSince(
  opts: FetchSinceOpts,
  workspaces: raw.AsanaWorkspaceInput[],
): Promise<raw.AsanaTaskInput[]> {
  // Asana DOES support `modified_since` on GET_MULTIPLE_TASKS; use the
  // sync cursor as lower bound to keep the per-window pull small.
  const sinceIso = opts.since.toISOString();
  const perWsLimit = Math.max(10, Math.floor(opts.limit / Math.max(workspaces.length, 1)));
  const out: raw.AsanaTaskInput[] = [];
  for (const ws of workspaces) {
    try {
      const response = await opts.fetcher('/tools/execute/ASANA_GET_MULTIPLE_TASKS', {
        method: 'POST',
        body: JSON.stringify({
          user_id: opts.userId, connected_account_id: opts.connectedAccountId,
          arguments: {
            workspace: ws.workspaceGid,
            assignee: 'me',
            modified_since: sinceIso,
            limit: Math.min(perWsLimit, 100),
          },
        }),
      });
      const tasks = extractAsanaList(response)
        .map((t: any) => mapAsanaTask(t, ws.workspaceGid))
        .filter((t): t is raw.AsanaTaskInput => !!t?.taskGid);
      out.push(...tasks);
      if (out.length >= opts.limit) break;
    } catch { /* per-workspace failure shouldn't sink rest */ }
  }
  return out.slice(0, opts.limit);
}

async function fetchHubspotContactsSince(opts: FetchSinceOpts): Promise<raw.HubspotContactInput[]> {
  // HubSpot search supports filtering by lastmodifieddate with GT operator.
  const sinceMs = opts.since.getTime();
  const response = await opts.fetcher('/tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {
        filterGroups: [{
          filters: [{
            propertyName: 'lastmodifieddate', operator: 'GT', value: String(sinceMs),
          }],
        }],
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
        properties: [
          'email', 'firstname', 'lastname', 'company', 'jobtitle',
          'lifecyclestage', 'hs_lead_status',
          'createdate', 'lastmodifieddate',
        ],
        limit: Math.min(opts.limit, 100),
      },
    }),
  });
  return extractHubspotContacts(response)
    .map(mapHubspotContact)
    .filter((c): c is raw.HubspotContactInput => !!c?.contactId)
    .slice(0, opts.limit);
}

async function fetchClickupUserSince(opts: FetchSinceOpts): Promise<raw.ClickupUserInput[]> {
  const response = await opts.fetcher('/tools/execute/CLICKUP_GET_AUTHORIZED_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapClickupUser(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchClickupWorkspacesSince(opts: FetchSinceOpts): Promise<raw.ClickupWorkspaceInput[]> {
  const response = await opts.fetcher('/tools/execute/CLICKUP_AUTHORIZATION_GET_WORK_SPACE_LIST', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId, connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  return extractClickupWorkspaces(response)
    .map(mapClickupWorkspace)
    .filter((w): w is raw.ClickupWorkspaceInput => !!w?.workspaceId)
    .slice(0, opts.limit);
}

async function fetchSpotifyRecentSince(opts: FetchSinceOpts): Promise<raw.SpotifyRecentTrackInput[]> {
  // Spotify Web API recently-played accepts `after` as a Unix ms timestamp.
  // Returns plays strictly after that instant. Caps at 50 per call —
  // Spotify only retains the last 50 plays anyway, so a 50-cap matches the
  // upstream limit.
  const afterMs = opts.since.getTime();
  const response = await opts.fetcher('/tools/execute/SPOTIFY_GET_RECENTLY_PLAYED_TRACKS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 50),
        after: afterMs,
      },
    }),
  });
  // Belt-and-suspenders client-side filter — if Composio strips `after` we
  // still don't write rows older than the cursor.
  return extractSpotifyRecentTracks(response)
    .map(mapSpotifyRecentTrack)
    .filter((t): t is raw.SpotifyRecentTrackInput => !!t?.trackId && !!t?.playedAt)
    .filter((t) => {
      const ms = Date.parse(t.playedAt);
      return Number.isFinite(ms) ? ms > afterMs : true;
    })
    .slice(0, opts.limit);
}
