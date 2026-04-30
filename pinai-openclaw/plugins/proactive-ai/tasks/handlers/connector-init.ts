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

export const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

export const SUPPORTED_TOOLKITS = [
  'gmail',
  'googlecalendar',
  // Phase D round 1
  'slack',
  'notion',
  'googledrive',
  // Phase D round 2
  'github',
  'outlook',
  // Phase D round 3 — schema-derived; only googledocs is live-verified
  'googledocs',
  'googlesheets',
  'stripe',
  'discord',
  // Phase D round 4
  'spotify',
  'strava',
  'todoist',
  'youtube',
  'trello',
  'jira',
  'twitter',
  'calendly',
  // Phase D round 5
  'linkedin',
  'figma',
  'zoom',
  'dropbox',
  'asana',
  'hubspot',
  'clickup',
] as const;
export type SupportedToolkit = typeof SUPPORTED_TOOLKITS[number];

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
      gdocs: [], gsheets: [], stripe: [], discord: [], spotifyRecent: [],
      stravaActivities: [], todoistTasks: [], youtubeSubs: [], trelloBoards: [],
      jiraProjects: [], twitterBookmarks: [], calendlyEvents: [],
      linkedinProfile: [], linkedinOrgs: [], figmaUser: [], zoomUser: [], zoomApps: [],
      dropboxAccount: [], dropboxFiles: [], asanaWorkspaces: [], asanaTasks: [],
      hubspotContacts: [], clickupUser: [], clickupWorkspaces: [],
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
    if (typedItems.gdocs && typedItems.gdocs.length > 0) {
      const r = raw.ingestGdocsDocuments(typedItems.gdocs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gdocs = r.ids;
    }
    if (typedItems.gsheets && typedItems.gsheets.length > 0) {
      const r = raw.ingestGsheetsSpreadsheets(typedItems.gsheets);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.gsheets = r.ids;
    }
    if (typedItems.stripe && typedItems.stripe.length > 0) {
      const r = raw.ingestStripeInvoices(typedItems.stripe);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.stripe = r.ids;
    }
    if (typedItems.discord && typedItems.discord.length > 0) {
      const r = raw.ingestDiscordGuilds(typedItems.discord);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.discord = r.ids;
    }
    if (typedItems.spotifyRecent && typedItems.spotifyRecent.length > 0) {
      const r = raw.ingestSpotifyRecentTracks(typedItems.spotifyRecent);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.spotifyRecent = r.ids;
    }
    if (typedItems.stravaActivities && typedItems.stravaActivities.length > 0) {
      const r = raw.ingestStravaActivities(typedItems.stravaActivities);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.stravaActivities = r.ids;
    }
    if (typedItems.todoistTasks && typedItems.todoistTasks.length > 0) {
      const r = raw.ingestTodoistTasks(typedItems.todoistTasks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.todoistTasks = r.ids;
    }
    if (typedItems.youtubeSubs && typedItems.youtubeSubs.length > 0) {
      const r = raw.ingestYoutubeSubscriptions(typedItems.youtubeSubs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.youtubeSubs = r.ids;
    }
    if (typedItems.trelloBoards && typedItems.trelloBoards.length > 0) {
      const r = raw.ingestTrelloBoards(typedItems.trelloBoards);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.trelloBoards = r.ids;
    }
    if (typedItems.jiraProjects && typedItems.jiraProjects.length > 0) {
      const r = raw.ingestJiraProjects(typedItems.jiraProjects);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.jiraProjects = r.ids;
    }
    if (typedItems.twitterBookmarks && typedItems.twitterBookmarks.length > 0) {
      const r = raw.ingestTwitterBookmarks(typedItems.twitterBookmarks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.twitterBookmarks = r.ids;
    }
    if (typedItems.calendlyEvents && typedItems.calendlyEvents.length > 0) {
      const r = raw.ingestCalendlyEvents(typedItems.calendlyEvents);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.calendlyEvents = r.ids;
    }
    if (typedItems.linkedinProfile && typedItems.linkedinProfile.length > 0) {
      const r = raw.ingestLinkedinProfile(typedItems.linkedinProfile);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.linkedinProfile = r.ids;
    }
    if (typedItems.linkedinOrgs && typedItems.linkedinOrgs.length > 0) {
      const r = raw.ingestLinkedinOrganizations(typedItems.linkedinOrgs);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.linkedinOrgs = r.ids;
    }
    if (typedItems.figmaUser && typedItems.figmaUser.length > 0) {
      const r = raw.ingestFigmaUser(typedItems.figmaUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.figmaUser = r.ids;
    }
    if (typedItems.zoomUser && typedItems.zoomUser.length > 0) {
      const r = raw.ingestZoomUser(typedItems.zoomUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.zoomUser = r.ids;
    }
    if (typedItems.zoomApps && typedItems.zoomApps.length > 0) {
      const r = raw.ingestZoomMarketplaceApps(typedItems.zoomApps);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.zoomApps = r.ids;
    }
    if (typedItems.dropboxAccount && typedItems.dropboxAccount.length > 0) {
      const r = raw.ingestDropboxAccount(typedItems.dropboxAccount);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.dropboxAccount = r.ids;
    }
    if (typedItems.dropboxFiles && typedItems.dropboxFiles.length > 0) {
      const r = raw.ingestDropboxFiles(typedItems.dropboxFiles);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.dropboxFiles = r.ids;
    }
    if (typedItems.asanaWorkspaces && typedItems.asanaWorkspaces.length > 0) {
      const r = raw.ingestAsanaWorkspaces(typedItems.asanaWorkspaces);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.asanaWorkspaces = r.ids;
    }
    if (typedItems.asanaTasks && typedItems.asanaTasks.length > 0) {
      const r = raw.ingestAsanaTasks(typedItems.asanaTasks);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.asanaTasks = r.ids;
    }
    if (typedItems.hubspotContacts && typedItems.hubspotContacts.length > 0) {
      const r = raw.ingestHubspotContacts(typedItems.hubspotContacts);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.hubspotContacts = r.ids;
    }
    if (typedItems.clickupUser && typedItems.clickupUser.length > 0) {
      const r = raw.ingestClickupUser(typedItems.clickupUser);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.clickupUser = r.ids;
    }
    if (typedItems.clickupWorkspaces && typedItems.clickupWorkspaces.length > 0) {
      const r = raw.ingestClickupWorkspaces(typedItems.clickupWorkspaces);
      rawInserted += r.inserted; rawIgnored += r.ignored;
      insertedRawIds.clickupWorkspaces = r.ids;
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
      gdocsRows: typedItems.gdocs ?? [],
      gdocsIds: insertedRawIds.gdocs,
      gsheetsRows: typedItems.gsheets ?? [],
      gsheetsIds: insertedRawIds.gsheets,
      stripeRows: typedItems.stripe ?? [],
      stripeIds: insertedRawIds.stripe,
      discordRows: typedItems.discord ?? [],
      discordIds: insertedRawIds.discord,
      spotifyRecentRows: typedItems.spotifyRecent ?? [],
      spotifyRecentIds: insertedRawIds.spotifyRecent,
      stravaRows: typedItems.stravaActivities ?? [],
      stravaIds: insertedRawIds.stravaActivities,
      todoistRows: typedItems.todoistTasks ?? [],
      todoistIds: insertedRawIds.todoistTasks,
      youtubeSubsRows: typedItems.youtubeSubs ?? [],
      youtubeSubsIds: insertedRawIds.youtubeSubs,
      trelloRows: typedItems.trelloBoards ?? [],
      trelloIds: insertedRawIds.trelloBoards,
      jiraRows: typedItems.jiraProjects ?? [],
      jiraIds: insertedRawIds.jiraProjects,
      twitterRows: typedItems.twitterBookmarks ?? [],
      twitterIds: insertedRawIds.twitterBookmarks,
      calendlyRows: typedItems.calendlyEvents ?? [],
      calendlyIds: insertedRawIds.calendlyEvents,
      linkedinProfileRows: typedItems.linkedinProfile ?? [],
      linkedinProfileIds: insertedRawIds.linkedinProfile,
      linkedinOrgRows: typedItems.linkedinOrgs ?? [],
      linkedinOrgIds: insertedRawIds.linkedinOrgs,
      figmaUserRows: typedItems.figmaUser ?? [],
      figmaUserIds: insertedRawIds.figmaUser,
      zoomUserRows: typedItems.zoomUser ?? [],
      zoomUserIds: insertedRawIds.zoomUser,
      zoomAppRows: typedItems.zoomApps ?? [],
      zoomAppIds: insertedRawIds.zoomApps,
      dropboxAccountRows: typedItems.dropboxAccount ?? [],
      dropboxAccountIds: insertedRawIds.dropboxAccount,
      dropboxFileRows: typedItems.dropboxFiles ?? [],
      dropboxFileIds: insertedRawIds.dropboxFiles,
      asanaWorkspaceRows: typedItems.asanaWorkspaces ?? [],
      asanaWorkspaceIds: insertedRawIds.asanaWorkspaces,
      asanaTaskRows: typedItems.asanaTasks ?? [],
      asanaTaskIds: insertedRawIds.asanaTasks,
      hubspotContactRows: typedItems.hubspotContacts ?? [],
      hubspotContactIds: insertedRawIds.hubspotContacts,
      clickupUserRows: typedItems.clickupUser ?? [],
      clickupUserIds: insertedRawIds.clickupUser,
      clickupWorkspaceRows: typedItems.clickupWorkspaces ?? [],
      clickupWorkspaceIds: insertedRawIds.clickupWorkspaces,
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
      if (insertedRawIds.gdocs.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'gdocs_documents', insertedRawIds.gdocs);
      }
      if (insertedRawIds.gsheets.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'gsheets_spreadsheets', insertedRawIds.gsheets);
      }
      if (insertedRawIds.stripe.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'stripe_invoices', insertedRawIds.stripe);
      }
      if (insertedRawIds.discord.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'discord_guilds', insertedRawIds.discord);
      }
      if (insertedRawIds.spotifyRecent.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'spotify_recent_tracks', insertedRawIds.spotifyRecent);
      }
      if (insertedRawIds.stravaActivities.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'strava_activities', insertedRawIds.stravaActivities);
      }
      if (insertedRawIds.todoistTasks.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'todoist_tasks', insertedRawIds.todoistTasks);
      }
      if (insertedRawIds.youtubeSubs.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'youtube_subscriptions', insertedRawIds.youtubeSubs);
      }
      if (insertedRawIds.trelloBoards.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'trello_boards', insertedRawIds.trelloBoards);
      }
      if (insertedRawIds.jiraProjects.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'jira_projects', insertedRawIds.jiraProjects);
      }
      if (insertedRawIds.twitterBookmarks.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'twitter_bookmarks', insertedRawIds.twitterBookmarks);
      }
      if (insertedRawIds.calendlyEvents.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'calendly_events', insertedRawIds.calendlyEvents);
      }
      if (insertedRawIds.linkedinProfile.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'linkedin_profile', insertedRawIds.linkedinProfile);
      }
      if (insertedRawIds.linkedinOrgs.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'linkedin_organizations', insertedRawIds.linkedinOrgs);
      }
      if (insertedRawIds.figmaUser.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'figma_user', insertedRawIds.figmaUser);
      }
      if (insertedRawIds.zoomUser.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'zoom_user', insertedRawIds.zoomUser);
      }
      if (insertedRawIds.zoomApps.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'zoom_marketplace_apps', insertedRawIds.zoomApps);
      }
      if (insertedRawIds.dropboxAccount.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'dropbox_account', insertedRawIds.dropboxAccount);
      }
      if (insertedRawIds.dropboxFiles.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'dropbox_files', insertedRawIds.dropboxFiles);
      }
      if (insertedRawIds.asanaWorkspaces.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'asana_workspaces', insertedRawIds.asanaWorkspaces);
      }
      if (insertedRawIds.asanaTasks.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'asana_tasks', insertedRawIds.asanaTasks);
      }
      if (insertedRawIds.hubspotContacts.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'hubspot_contacts', insertedRawIds.hubspotContacts);
      }
      if (insertedRawIds.clickupUser.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'clickup_user', insertedRawIds.clickupUser);
      }
      if (insertedRawIds.clickupWorkspaces.length > 0) {
        await db.recordEvolutionRefsConsumed(evo.id, 'clickup_workspaces', insertedRawIds.clickupWorkspaces);
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
            discord: typedItems.discord,
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
  gdocs?: raw.GdocsDocumentInput[];
  gsheets?: raw.GsheetsSpreadsheetInput[];
  stripe?: raw.StripeInvoiceInput[];
  discord?: raw.DiscordGuildInput[];
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
  gmail: string[];
  gcal: string[];
  slack: string[];
  notion: string[];
  gdrive: string[];
  github: string[];
  outlook: string[];
  gdocs: string[];
  gsheets: string[];
  stripe: string[];
  discord: string[];
  spotifyRecent: string[];
  stravaActivities: string[];
  todoistTasks: string[];
  youtubeSubs: string[];
  trelloBoards: string[];
  jiraProjects: string[];
  twitterBookmarks: string[];
  calendlyEvents: string[];
  linkedinProfile: string[];
  linkedinOrgs: string[];
  figmaUser: string[];
  zoomUser: string[];
  zoomApps: string[];
  dropboxAccount: string[];
  dropboxFiles: string[];
  asanaWorkspaces: string[];
  asanaTasks: string[];
  hubspotContacts: string[];
  clickupUser: string[];
  clickupWorkspaces: string[];
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
  if (toolkit === 'googledocs') {
    return { gdocs: await fetchGdocsRecent(opts) };
  }
  if (toolkit === 'googlesheets') {
    return { gsheets: await fetchGsheetsRecent(opts) };
  }
  if (toolkit === 'stripe') {
    return { stripe: await fetchStripeRecent(opts) };
  }
  if (toolkit === 'discord') {
    return { discord: await fetchDiscordRecent(opts) };
  }
  if (toolkit === 'spotify') {
    return { spotifyRecent: await fetchSpotifyRecent(opts) };
  }
  if (toolkit === 'strava') {
    return { stravaActivities: await fetchStravaRecent(opts) };
  }
  if (toolkit === 'todoist') {
    return { todoistTasks: await fetchTodoistRecent(opts) };
  }
  if (toolkit === 'youtube') {
    return { youtubeSubs: await fetchYoutubeRecent(opts) };
  }
  if (toolkit === 'trello') {
    return { trelloBoards: await fetchTrelloRecent(opts) };
  }
  if (toolkit === 'jira') {
    return { jiraProjects: await fetchJiraRecent(opts) };
  }
  if (toolkit === 'twitter') {
    return { twitterBookmarks: await fetchTwitterRecent(opts) };
  }
  if (toolkit === 'calendly') {
    return { calendlyEvents: await fetchCalendlyRecent(opts) };
  }
  if (toolkit === 'linkedin') {
    const [profile, orgs] = await Promise.all([
      fetchLinkedinProfileRecent(opts),
      fetchLinkedinOrgsRecent(opts),
    ]);
    return { linkedinProfile: profile, linkedinOrgs: orgs };
  }
  if (toolkit === 'figma') {
    return { figmaUser: await fetchFigmaUserRecent(opts) };
  }
  if (toolkit === 'zoom') {
    const [user, apps] = await Promise.all([
      fetchZoomUserRecent(opts),
      fetchZoomAppsRecent(opts),
    ]);
    return { zoomUser: user, zoomApps: apps };
  }
  if (toolkit === 'dropbox') {
    const [account, files] = await Promise.all([
      fetchDropboxAccountRecent(opts),
      fetchDropboxFilesRecent(opts),
    ]);
    return { dropboxAccount: account, dropboxFiles: files };
  }
  if (toolkit === 'asana') {
    // Two-step: list workspaces first, then per-workspace assignee=me tasks.
    const workspaces = await fetchAsanaWorkspacesRecent(opts);
    const tasks = await fetchAsanaTasksAcrossWorkspaces(opts, workspaces);
    return { asanaWorkspaces: workspaces, asanaTasks: tasks };
  }
  if (toolkit === 'hubspot') {
    return { hubspotContacts: await fetchHubspotContactsRecent(opts) };
  }
  if (toolkit === 'clickup') {
    const [user, workspaces] = await Promise.all([
      fetchClickupUserRecent(opts),
      fetchClickupWorkspacesRecent(opts),
    ]);
    return { clickupUser: user, clickupWorkspaces: workspaces };
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

async function fetchGdocsRecent(opts: FetchToolkitItemsOpts): Promise<raw.GdocsDocumentInput[]> {
  // GOOGLEDOCS_SEARCH_DOCUMENTS — verified live 2026-04-24. Returns
  // Drive-API rows under data.documents. Default order is modifiedTime
  // desc which matches what we want for "what has the user been writing
  // lately".
  const response = await opts.fetcher('/tools/execute/GOOGLEDOCS_SEARCH_DOCUMENTS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        order_by: 'modifiedTime desc',
        include_trashed: false,
      },
    }),
  });
  const docs = extractGdocsDocuments(response);
  return docs
    .map(mapGdocsDocument)
    .filter((d): d is raw.GdocsDocumentInput => !!d?.documentId)
    .slice(0, opts.limit);
}

async function fetchGsheetsRecent(opts: FetchToolkitItemsOpts): Promise<raw.GsheetsSpreadsheetInput[]> {
  // GOOGLESHEETS_SEARCH_SPREADSHEETS — schema-derived (not live-verified).
  // Same arg/response pattern as GOOGLEDOCS_SEARCH_DOCUMENTS.
  const response = await opts.fetcher('/tools/execute/GOOGLESHEETS_SEARCH_SPREADSHEETS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        max_results: opts.limit,
        order_by: 'modifiedTime desc',
        include_trashed: false,
      },
    }),
  });
  const sheets = extractGsheetsSpreadsheets(response);
  return sheets
    .map(mapGsheetsSpreadsheet)
    .filter((s): s is raw.GsheetsSpreadsheetInput => !!s?.spreadsheetId)
    .slice(0, opts.limit);
}

async function fetchStripeRecent(opts: FetchToolkitItemsOpts): Promise<raw.StripeInvoiceInput[]> {
  // STRIPE_LIST_INVOICES — schema-derived. Stripe's standard List API
  // returns { object: 'list', data: [...], has_more, ... }. limit caps
  // at 100 per Stripe's docs.
  const response = await opts.fetcher('/tools/execute/STRIPE_LIST_INVOICES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 100),
      },
    }),
  });
  const invoices = extractStripeInvoices(response);
  return invoices
    .map(mapStripeInvoice)
    .filter((i): i is raw.StripeInvoiceInput => !!i?.invoiceId)
    .slice(0, opts.limit);
}

async function fetchDiscordRecent(opts: FetchToolkitItemsOpts): Promise<raw.DiscordGuildInput[]> {
  // DISCORD_LIST_MY_GUILDS — schema-derived. Returns up to 200 guilds
  // (servers). with_counts=true gets the member/presence counts.
  const response = await opts.fetcher('/tools/execute/DISCORD_LIST_MY_GUILDS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 200),
        with_counts: true,
      },
    }),
  });
  const guilds = extractDiscordGuilds(response);
  return guilds
    .map(mapDiscordGuild)
    .filter((g): g is raw.DiscordGuildInput => !!g?.guildId)
    .slice(0, opts.limit);
}

async function fetchSpotifyRecent(opts: FetchToolkitItemsOpts): Promise<raw.SpotifyRecentTrackInput[]> {
  // SPOTIFY_GET_RECENTLY_PLAYED_TRACKS — Spotify Web API caps at 50 items
  // per call. We clamp to 50 even if caller asked for more; users rarely
  // need a deeper history on init (sync picks up the rest with `after`).
  const response = await opts.fetcher('/tools/execute/SPOTIFY_GET_RECENTLY_PLAYED_TRACKS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 50),
      },
    }),
  });
  const items = extractSpotifyRecentTracks(response);
  return items
    .map(mapSpotifyRecentTrack)
    .filter((t): t is raw.SpotifyRecentTrackInput => !!t?.trackId && !!t?.playedAt)
    .slice(0, opts.limit);
}

async function fetchStravaRecent(opts: FetchToolkitItemsOpts): Promise<raw.StravaActivityInput[]> {
  // STRAVA_LIST_ATHLETE_ACTIVITIES — paginated; per_page max 200. No
  // params required. Sort is implicitly start_date desc on Strava's side.
  const response = await opts.fetcher('/tools/execute/STRAVA_LIST_ATHLETE_ACTIVITIES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        per_page: Math.min(opts.limit, 200),
      },
    }),
  });
  return extractStravaActivities(response)
    .map(mapStravaActivity)
    .filter((a): a is raw.StravaActivityInput => !!a?.activityId)
    .slice(0, opts.limit);
}

async function fetchTodoistRecent(opts: FetchToolkitItemsOpts): Promise<raw.TodoistTaskInput[]> {
  // TODOIST_GET_ALL_TASKS — returns all incomplete tasks. No required
  // params. Todoist API caps page size at 200. Cursor pagination exists
  // but for init we take only the first page; users rarely have >200
  // active tasks and the sync handler will pick up new ones later.
  const response = await opts.fetcher('/tools/execute/TODOIST_GET_ALL_TASKS', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        limit: Math.min(opts.limit, 200),
      },
    }),
  });
  return extractTodoistTasks(response)
    .map(mapTodoistTask)
    .filter((t): t is raw.TodoistTaskInput => !!t?.taskId)
    .slice(0, opts.limit);
}

async function fetchYoutubeRecent(opts: FetchToolkitItemsOpts): Promise<raw.YoutubeSubscriptionInput[]> {
  // YOUTUBE_LIST_USER_SUBSCRIPTIONS — `mine: true` scopes to the
  // authenticated user. part includes snippet so we get channel title
  // and description. maxResults caps at 50 per call (YouTube Data v3).
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

async function fetchTrelloRecent(opts: FetchToolkitItemsOpts): Promise<raw.TrelloBoardInput[]> {
  // TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER with idMember=me returns the
  // authenticated user's boards. filter=open excludes archived; we DON'T
  // filter here so evolve can see "X archived projects" as a signal.
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

async function fetchJiraRecent(opts: FetchToolkitItemsOpts): Promise<raw.JiraProjectInput[]> {
  // JIRA_GET_RECENT_PROJECTS — projects the authenticated user has
  // accessed recently. No params strictly required.
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

async function fetchTwitterRecent(opts: FetchToolkitItemsOpts): Promise<raw.TwitterBookmarkInput[]> {
  // TWITTER_BOOKMARKS_BY_USER — id='me' returns the authenticated user's
  // bookmarks. Twitter v2 caps at 100 per page; expansions=author_id
  // pulls author username/display name into includes.users for join.
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

async function fetchCalendlyRecent(opts: FetchToolkitItemsOpts): Promise<raw.CalendlyEventInput[]> {
  // Two-step: first resolve the user URI via CALENDLY_GET_USER (uuid='me'),
  // then list events scoped to that user. Calendly explicitly rejects
  // shortcuts like 'me' on /scheduled_events — must pass the full URI.
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
      },
    }),
  });
  return extractCalendlyEvents(response)
    .map(mapCalendlyEvent)
    .filter((e): e is raw.CalendlyEventInput => !!e?.eventUri)
    .slice(0, opts.limit);
}

async function fetchLinkedinProfileRecent(opts: FetchToolkitItemsOpts): Promise<raw.LinkedinProfileInput[]> {
  const response = await opts.fetcher('/tools/execute/LINKEDIN_GET_MY_INFO', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapLinkedinProfile(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchLinkedinOrgsRecent(opts: FetchToolkitItemsOpts): Promise<raw.LinkedinOrganizationInput[]> {
  const response = await opts.fetcher('/tools/execute/LINKEDIN_GET_COMPANY_INFO', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { count: Math.min(opts.limit, 50) },
    }),
  });
  return extractLinkedinOrganizations(response)
    .map(mapLinkedinOrganization)
    .filter((o): o is raw.LinkedinOrganizationInput => !!o?.orgUrn)
    .slice(0, opts.limit);
}

async function fetchFigmaUserRecent(opts: FetchToolkitItemsOpts): Promise<raw.FigmaUserInput[]> {
  const response = await opts.fetcher('/tools/execute/FIGMA_GET_CURRENT_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapFigmaUser(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchZoomUserRecent(opts: FetchToolkitItemsOpts): Promise<raw.ZoomUserInput[]> {
  const response = await opts.fetcher('/tools/execute/ZOOM_GET_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { userId: 'me' },
    }),
  });
  const mapped = mapZoomUser(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchZoomAppsRecent(opts: FetchToolkitItemsOpts): Promise<raw.ZoomMarketplaceAppInput[]> {
  // Some accounts will 403 here (admin-scoped action on org-controlled
  // installs). Treat that as "no apps to report" and return [] rather
  // than failing the whole init.
  try {
    const response = await opts.fetcher('/tools/execute/ZOOM_GET_MARKETPLACE_USER_APPS', {
      method: 'POST',
      body: JSON.stringify({
        user_id: opts.userId,
        connected_account_id: opts.connectedAccountId,
        arguments: { id: 'me', page_size: Math.min(opts.limit, 100) },
      }),
    });
    return extractZoomMarketplaceApps(response)
      .map(mapZoomMarketplaceApp)
      .filter((a): a is raw.ZoomMarketplaceAppInput => !!a?.appInstallId)
      .slice(0, opts.limit);
  } catch {
    return [];
  }
}

async function fetchDropboxAccountRecent(opts: FetchToolkitItemsOpts): Promise<raw.DropboxAccountInput[]> {
  const response = await opts.fetcher('/tools/execute/DROPBOX_GET_ABOUT_ME', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapDropboxAccount(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchDropboxFilesRecent(opts: FetchToolkitItemsOpts): Promise<raw.DropboxFileInput[]> {
  // Dropbox list_folder with path='' returns root-level entries. We don't
  // recurse — recursive listing of an entire account would be huge and
  // is best left for a deliberate background job.
  const response = await opts.fetcher('/tools/execute/DROPBOX_LIST_FOLDER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { path: '', limit: Math.min(opts.limit, 2000) },
    }),
  });
  return extractDropboxFiles(response)
    .map(mapDropboxFile)
    .filter((f): f is raw.DropboxFileInput => !!f?.fileId)
    .slice(0, opts.limit);
}

async function fetchAsanaWorkspacesRecent(opts: FetchToolkitItemsOpts): Promise<raw.AsanaWorkspaceInput[]> {
  const response = await opts.fetcher('/tools/execute/ASANA_GET_WORKSPACES', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: { limit: 100 },
    }),
  });
  return extractAsanaList(response)
    .map(mapAsanaWorkspace)
    .filter((w): w is raw.AsanaWorkspaceInput => !!w?.workspaceGid);
}

async function fetchAsanaTasksAcrossWorkspaces(
  opts: FetchToolkitItemsOpts,
  workspaces: raw.AsanaWorkspaceInput[],
): Promise<raw.AsanaTaskInput[]> {
  // Pull tasks per workspace — Asana's GET_MULTIPLE_TASKS requires a
  // workspace gid when filtering by assignee. We cap the per-workspace
  // budget so a user with many workspaces doesn't explode the call count.
  const perWorkspaceLimit = Math.max(10, Math.floor(opts.limit / Math.max(workspaces.length, 1)));
  const results: raw.AsanaTaskInput[] = [];
  for (const ws of workspaces) {
    try {
      const response = await opts.fetcher('/tools/execute/ASANA_GET_MULTIPLE_TASKS', {
        method: 'POST',
        body: JSON.stringify({
          user_id: opts.userId,
          connected_account_id: opts.connectedAccountId,
          arguments: {
            workspace: ws.workspaceGid,
            assignee: 'me',
            completed_since: 'now',  // incomplete only
            limit: Math.min(perWorkspaceLimit, 100),
          },
        }),
      });
      const tasks = extractAsanaList(response)
        .map((t: any) => mapAsanaTask(t, ws.workspaceGid))
        .filter((t): t is raw.AsanaTaskInput => !!t?.taskGid);
      results.push(...tasks);
      if (results.length >= opts.limit) break;
    } catch {
      // Per-workspace failure (auth, rate limit) shouldn't sink the rest.
    }
  }
  return results.slice(0, opts.limit);
}

async function fetchHubspotContactsRecent(opts: FetchToolkitItemsOpts): Promise<raw.HubspotContactInput[]> {
  // Search for contacts ordered by lastmodifieddate desc. The "broad
  // filter" trick: filter on createdate >= epoch(0) is always true, but
  // HubSpot's search API requires at least one filter to return data.
  const response = await opts.fetcher('/tools/execute/HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {
        filterGroups: [{
          filters: [{ propertyName: 'createdate', operator: 'GT', value: '0' }],
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

async function fetchClickupUserRecent(opts: FetchToolkitItemsOpts): Promise<raw.ClickupUserInput[]> {
  const response = await opts.fetcher('/tools/execute/CLICKUP_GET_AUTHORIZED_USER', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  const mapped = mapClickupUser(unwrapDataPaths(response)[0] ?? response);
  return mapped ? [mapped] : [];
}

async function fetchClickupWorkspacesRecent(opts: FetchToolkitItemsOpts): Promise<raw.ClickupWorkspaceInput[]> {
  const response = await opts.fetcher('/tools/execute/CLICKUP_AUTHORIZATION_GET_WORK_SPACE_LIST', {
    method: 'POST',
    body: JSON.stringify({
      user_id: opts.userId,
      connected_account_id: opts.connectedAccountId,
      arguments: {},
    }),
  });
  return extractClickupWorkspaces(response)
    .map(mapClickupWorkspace)
    .filter((w): w is raw.ClickupWorkspaceInput => !!w?.workspaceId)
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

export function extractGmailMessages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    if (Array.isArray(c?.messages)) return c.messages;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractGcalEvents(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    if (Array.isArray(c?.events)) return c.events;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractSlackMessages(response: unknown): any[] {
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

export function extractNotionPages(response: unknown): any[] {
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

export function extractGdriveFiles(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Drive API: { files: [...] }
    if (Array.isArray(c?.files)) return c.files;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractGithubIssues(response: unknown): any[] {
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

export function extractOutlookMessages(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Microsoft Graph: { value: [...] }
    if (Array.isArray(c?.value)) return c.value;
    if (Array.isArray(c?.messages)) return c.messages;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractGdocsDocuments(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Verified live 2026-04-24: data.documents
    if (Array.isArray(c?.documents)) return c.documents;
    if (Array.isArray(c?.files)) return c.files;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractGsheetsSpreadsheets(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Schema-derived; mirroring GoogleDocs' shape since both wrap Drive.
    if (Array.isArray(c?.spreadsheets)) return c.spreadsheets;
    if (Array.isArray(c?.documents)) return c.documents;
    if (Array.isArray(c?.files)) return c.files;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractStripeInvoices(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Stripe's standard list shape: { object: 'list', data: [...] }
    if (Array.isArray(c?.data)) return c.data;
    if (Array.isArray(c?.invoices)) return c.invoices;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractDiscordGuilds(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Discord raw API returns a top-level array; Composio likely wraps under data.guilds.
    if (Array.isArray(c?.guilds)) return c.guilds;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractSpotifyRecentTracks(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Spotify Web API: { items: [{ track: {...}, played_at: "..." }, ...] }
    if (Array.isArray(c?.items)) return c.items;
    if (Array.isArray(c?.tracks)) return c.tracks;
  }
  return [];
}

export function extractStravaActivities(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Strava raw API returns a top-level array; Composio likely wraps it.
    if (Array.isArray(c?.activities)) return c.activities;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractTodoistTasks(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Todoist v2: { results: [...], next_cursor }; v1: top-level array.
    if (Array.isArray(c?.results)) return c.results;
    if (Array.isArray(c?.tasks)) return c.tasks;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractYoutubeSubscriptions(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // YouTube Data v3: { items: [...], pageInfo, nextPageToken }
    if (Array.isArray(c?.items)) return c.items;
    if (Array.isArray(c?.subscriptions)) return c.subscriptions;
  }
  return [];
}

export function extractTrelloBoards(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Trello: top-level array. Composio likely wraps as data.boards or data.
    if (Array.isArray(c?.boards)) return c.boards;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractJiraProjects(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Jira: GET_RECENT_PROJECTS may return either a top-level array or
    // wrapped under data.projects / data.values (paginated shape).
    if (Array.isArray(c?.projects)) return c.projects;
    if (Array.isArray(c?.values)) return c.values;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractTwitterBookmarks(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Twitter v2: { data: [...], includes: { users: [...] }, meta }.
    // Note this collides with our outer unwrapDataPaths which already
    // peels `data` once — by the time we look at candidates, c.data may
    // be the bookmark array directly.
    if (Array.isArray(c?.data)) return c.data;
    if (Array.isArray(c?.bookmarks)) return c.bookmarks;
    if (Array.isArray(c)) return c;
  }
  return [];
}

export function extractTwitterUserIncludes(response: unknown): Record<string, { username?: string; name?: string }> {
  const out: Record<string, { username?: string; name?: string }> = {};
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    const users = c?.includes?.users;
    if (Array.isArray(users)) {
      for (const u of users) {
        if (u && typeof u === 'object' && typeof u.id === 'string') {
          out[u.id] = { username: u.username, name: u.name };
        }
      }
    }
  }
  return out;
}

export function extractCalendlyUserUri(response: unknown): string | null {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Calendly: { resource: { uri: "https://api.calendly.com/users/<uuid>" } }
    const uri = c?.resource?.uri ?? c?.uri;
    if (typeof uri === 'string' && uri.startsWith('https://api.calendly.com/users/')) {
      return uri;
    }
  }
  return null;
}

export function extractCalendlyEvents(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Calendly: { collection: [...], pagination } per their docs.
    if (Array.isArray(c?.collection)) return c.collection;
    if (Array.isArray(c?.events)) return c.events;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractLinkedinOrganizations(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // LinkedIn returns under `elements` (paginated collection) typically.
    if (Array.isArray(c?.elements)) return c.elements;
    if (Array.isArray(c?.organizations)) return c.organizations;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractZoomMarketplaceApps(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Zoom marketplace: `{ apps: [...], page_size, next_page_token }`
    if (Array.isArray(c?.apps)) return c.apps;
    if (Array.isArray(c?.installations)) return c.installations;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractDropboxFiles(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Dropbox list_folder: `{ entries: [...], cursor, has_more }`
    if (Array.isArray(c?.entries)) return c.entries;
    if (Array.isArray(c?.files)) return c.files;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractAsanaList(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // Asana: `{ data: [...], next_page }` — but unwrapDataPaths peels
    // `data` first; check both. Workspaces & tasks share the same shape.
    if (Array.isArray(c?.data)) return c.data;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractHubspotContacts(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // HubSpot search: `{ total, results: [...], paging }`
    if (Array.isArray(c?.results)) return c.results;
    if (Array.isArray(c?.contacts)) return c.contacts;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function extractClickupWorkspaces(response: unknown): any[] {
  const candidates = unwrapDataPaths(response);
  for (const c of candidates) {
    // ClickUp: `{ teams: [...] }` — they call workspaces "teams" in API.
    if (Array.isArray(c?.teams)) return c.teams;
    if (Array.isArray(c?.workspaces)) return c.workspaces;
    if (Array.isArray(c)) return c;
    if (Array.isArray(c?.items)) return c.items;
  }
  return [];
}

export function unwrapDataPaths(response: unknown): any[] {
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

export function mapGmailMessage(msg: any): raw.GmailMessageInput | null {
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

export function mapGcalEvent(evt: any): raw.GcalEventInput | null {
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

export function mapSlackMessage(msg: any): raw.SlackMessageInput | null {
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

export function mapNotionPage(page: any): raw.NotionPageInput | null {
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

export function mapGithubIssue(issue: any): raw.GithubIssueInput | null {
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

export function mapOutlookMessage(msg: any): raw.OutlookMessageInput | null {
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

function flattenDriveOwners(file: any): string[] {
  if (!Array.isArray(file?.owners)) return [];
  return file.owners
    .map((o: any) => o?.emailAddress ?? o?.displayName ?? null)
    .filter((s: any): s is string => typeof s === 'string' && s.length > 0);
}

function flattenDriveLastModifyingUser(file: any): string | null {
  const lmu = file?.lastModifyingUser;
  if (!lmu || typeof lmu !== 'object') return null;
  return lmu.emailAddress ?? lmu.displayName ?? null;
}

export function mapGdocsDocument(doc: any): raw.GdocsDocumentInput | null {
  if (!doc || typeof doc !== 'object') return null;
  const documentId = String(doc.id ?? doc.document_id ?? '').trim();
  if (!documentId) return null;
  return {
    documentId,
    name: doc.name ?? null,
    modifiedTime: doc.modifiedTime ?? doc.modified_time ?? null,
    createdTime: doc.createdTime ?? doc.created_time ?? null,
    webViewLink: doc.webViewLink ?? doc.web_view_link ?? null,
    owners: flattenDriveOwners(doc),
    lastModifyingUser: flattenDriveLastModifyingUser(doc),
    starred: Boolean(doc.starred),
    trashed: Boolean(doc.trashed),
    shared: Boolean(doc.shared),
  };
}

export function mapGsheetsSpreadsheet(sheet: any): raw.GsheetsSpreadsheetInput | null {
  if (!sheet || typeof sheet !== 'object') return null;
  const spreadsheetId = String(sheet.id ?? sheet.spreadsheet_id ?? '').trim();
  if (!spreadsheetId) return null;
  return {
    spreadsheetId,
    name: sheet.name ?? null,
    modifiedTime: sheet.modifiedTime ?? sheet.modified_time ?? null,
    createdTime: sheet.createdTime ?? sheet.created_time ?? null,
    webViewLink: sheet.webViewLink ?? sheet.web_view_link ?? null,
    owners: flattenDriveOwners(sheet),
    lastModifyingUser: flattenDriveLastModifyingUser(sheet),
    starred: Boolean(sheet.starred),
    trashed: Boolean(sheet.trashed),
    shared: Boolean(sheet.shared),
  };
}

export function mapStripeInvoice(inv: any): raw.StripeInvoiceInput | null {
  if (!inv || typeof inv !== 'object') return null;
  const invoiceId = String(inv.id ?? inv.invoice_id ?? '').trim();
  if (!invoiceId) return null;
  // Stripe's customer field is either an id string or an expanded object.
  let customerId: string | null = null;
  let customerEmail: string | null = null;
  let customerName: string | null = null;
  if (typeof inv.customer === 'string') {
    customerId = inv.customer;
    // customer_email / customer_name are top-level even when customer is just an id
    customerEmail = inv.customer_email ?? null;
    customerName = inv.customer_name ?? null;
  } else if (inv.customer && typeof inv.customer === 'object') {
    customerId = inv.customer.id ?? null;
    customerEmail = inv.customer.email ?? inv.customer_email ?? null;
    customerName = inv.customer.name ?? inv.customer_name ?? null;
  } else {
    customerEmail = inv.customer_email ?? null;
    customerName = inv.customer_name ?? null;
  }
  // created is epoch seconds; convert to ISO
  const createdAtRemote = stripeEpochToIso(inv.created);
  const dueDate = stripeEpochToIso(inv.due_date);
  return {
    invoiceId,
    number: inv.number ?? null,
    status: inv.status ?? null,
    amountDue: typeof inv.amount_due === 'number' ? inv.amount_due : null,
    amountPaid: typeof inv.amount_paid === 'number' ? inv.amount_paid : null,
    amountRemaining: typeof inv.amount_remaining === 'number' ? inv.amount_remaining : null,
    currency: inv.currency ?? null,
    customerId,
    customerEmail,
    customerName,
    collectionMethod: inv.collection_method ?? null,
    createdAtRemote,
    dueDate,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
  };
}

function stripeEpochToIso(value: unknown): string | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Stripe consistently uses epoch seconds (10-digit) in 2026.
  return new Date(n * 1000).toISOString();
}

export function mapDiscordGuild(guild: any): raw.DiscordGuildInput | null {
  if (!guild || typeof guild !== 'object') return null;
  const guildId = String(guild.id ?? guild.guild_id ?? '').trim();
  if (!guildId) return null;
  return {
    guildId,
    name: guild.name ?? null,
    icon: guild.icon ?? null,
    isOwner: Boolean(guild.owner),
    permissions: typeof guild.permissions === 'string' ? guild.permissions : null,
    features: Array.isArray(guild.features)
      ? guild.features.filter((f: any): f is string => typeof f === 'string')
      : [],
    approximateMemberCount: typeof guild.approximate_member_count === 'number'
      ? guild.approximate_member_count : null,
    approximatePresenceCount: typeof guild.approximate_presence_count === 'number'
      ? guild.approximate_presence_count : null,
  };
}

export function mapSpotifyRecentTrack(item: any): raw.SpotifyRecentTrackInput | null {
  if (!item || typeof item !== 'object') return null;
  // Spotify Web API: each item is { track: {...}, played_at: ISO, context: {...} }.
  // Composio sometimes flattens it ({...track props, played_at}); be defensive.
  const track = item.track && typeof item.track === 'object' ? item.track : item;
  const trackId = String(track?.id ?? track?.trackId ?? '').trim();
  const playedAtRaw = item.played_at ?? item.playedAt ?? track?.played_at ?? null;
  const playedAt = typeof playedAtRaw === 'string' ? playedAtRaw.trim() : '';
  if (!trackId || !playedAt) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists
        .map((a: any) => (typeof a?.name === 'string' ? a.name : (typeof a === 'string' ? a : null)))
        .filter((s: any): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const album = track.album && typeof track.album === 'object'
    ? (typeof track.album.name === 'string' ? track.album.name : null)
    : null;
  const trackUrl = track.external_urls && typeof track.external_urls === 'object'
    ? (typeof track.external_urls.spotify === 'string' ? track.external_urls.spotify : null)
    : (typeof track.url === 'string' ? track.url : null);
  const ctx = item.context && typeof item.context === 'object' ? item.context : null;
  const contextType = ctx && typeof ctx.type === 'string' ? ctx.type : null;
  const contextUri = ctx && typeof ctx.uri === 'string' ? ctx.uri : null;
  return {
    trackId,
    trackName: typeof track.name === 'string' ? track.name : null,
    artistNames: artists,
    albumName: album,
    durationMs: typeof track.duration_ms === 'number' ? track.duration_ms : null,
    popularity: typeof track.popularity === 'number' ? track.popularity : null,
    trackUrl,
    playedAt,
    contextType,
    contextUri,
  };
}

export function mapStravaActivity(act: any): raw.StravaActivityInput | null {
  if (!act || typeof act !== 'object') return null;
  // Strava ids are bigints; preserve precision by storing as string.
  const idRaw = act.id ?? act.activity_id ?? act.activityId ?? null;
  const activityId = typeof idRaw === 'string' ? idRaw.trim()
    : typeof idRaw === 'number' ? String(idRaw)
    : '';
  if (!activityId) return null;
  return {
    activityId,
    name: typeof act.name === 'string' ? act.name : null,
    activityType: typeof act.type === 'string' ? act.type
      : typeof act.sport_type === 'string' ? act.sport_type : null,
    distanceMeters: typeof act.distance === 'number' ? act.distance : null,
    movingTimeSeconds: typeof act.moving_time === 'number' ? act.moving_time : null,
    elapsedTimeSeconds: typeof act.elapsed_time === 'number' ? act.elapsed_time : null,
    elevationGainMeters: typeof act.total_elevation_gain === 'number' ? act.total_elevation_gain : null,
    startDate: typeof act.start_date === 'string' ? act.start_date : null,
    timezone: typeof act.timezone === 'string' ? act.timezone : null,
    averageSpeedMps: typeof act.average_speed === 'number' ? act.average_speed : null,
    maxSpeedMps: typeof act.max_speed === 'number' ? act.max_speed : null,
    averageHeartrate: typeof act.average_heartrate === 'number' ? act.average_heartrate : null,
    maxHeartrate: typeof act.max_heartrate === 'number' ? act.max_heartrate : null,
    kudosCount: typeof act.kudos_count === 'number' ? act.kudos_count : null,
  };
}

export function mapTodoistTask(task: any): raw.TodoistTaskInput | null {
  if (!task || typeof task !== 'object') return null;
  const taskId = String(task.id ?? task.task_id ?? '').trim();
  if (!taskId) return null;
  // Todoist `due` is an object {date, datetime, timezone, string}; we
  // prefer datetime when set, fall back to date.
  const due = task.due && typeof task.due === 'object'
    ? (typeof task.due.datetime === 'string' ? task.due.datetime
       : typeof task.due.date === 'string' ? task.due.date : null)
    : null;
  return {
    taskId,
    content: typeof task.content === 'string' ? task.content : null,
    description: typeof task.description === 'string' ? task.description : null,
    projectId: task.project_id != null ? String(task.project_id) : null,
    parentTaskId: task.parent_id != null ? String(task.parent_id) : null,
    priority: typeof task.priority === 'number' ? task.priority : null,
    labels: Array.isArray(task.labels)
      ? task.labels.filter((l: any): l is string => typeof l === 'string')
      : [],
    dueAt: due,
    isCompleted: Boolean(task.is_completed ?? task.completed),
    createdAtRemote: typeof task.created_at === 'string' ? task.created_at : null,
  };
}

export function mapYoutubeSubscription(sub: any): raw.YoutubeSubscriptionInput | null {
  if (!sub || typeof sub !== 'object') return null;
  const subscriptionId = String(sub.id ?? sub.subscription_id ?? '').trim();
  // Channel id lives in snippet.resourceId.channelId (YouTube Data v3 quirk).
  const snippet = sub.snippet && typeof sub.snippet === 'object' ? sub.snippet : {};
  const channelId = String(snippet?.resourceId?.channelId ?? snippet?.channelId ?? sub.channel_id ?? '').trim();
  if (!subscriptionId || !channelId) return null;
  const thumbnails = snippet?.thumbnails ?? null;
  const thumbnailUrl = thumbnails && typeof thumbnails === 'object'
    ? (typeof thumbnails.default?.url === 'string' ? thumbnails.default.url
       : typeof thumbnails.medium?.url === 'string' ? thumbnails.medium.url
       : null)
    : null;
  return {
    subscriptionId,
    channelId,
    channelTitle: typeof snippet.title === 'string' ? snippet.title : null,
    channelDescription: typeof snippet.description === 'string' ? snippet.description : null,
    thumbnailUrl,
    subscribedAt: typeof snippet.publishedAt === 'string' ? snippet.publishedAt : null,
  };
}

export function mapTrelloBoard(board: any): raw.TrelloBoardInput | null {
  if (!board || typeof board !== 'object') return null;
  const boardId = String(board.id ?? board.board_id ?? '').trim();
  if (!boardId) return null;
  // Trello uses `desc` (truncated) and `descData` (markdown source).
  const description = typeof board.desc === 'string' ? board.desc
    : typeof board.description === 'string' ? board.description : null;
  return {
    boardId,
    name: typeof board.name === 'string' ? board.name : null,
    description,
    url: typeof board.url === 'string' ? board.url : null,
    organizationId: board.idOrganization != null ? String(board.idOrganization) : null,
    closed: Boolean(board.closed),
    starred: Boolean(board.starred),
    pinned: Boolean(board.pinned),
    lastActivityAt: typeof board.dateLastActivity === 'string' ? board.dateLastActivity : null,
  };
}

export function mapJiraProject(proj: any): raw.JiraProjectInput | null {
  if (!proj || typeof proj !== 'object') return null;
  const projectId = String(proj.id ?? proj.project_id ?? '').trim();
  if (!projectId) return null;
  const lead = proj.lead && typeof proj.lead === 'object'
    ? (typeof proj.lead.displayName === 'string' ? proj.lead.displayName
       : typeof proj.lead.name === 'string' ? proj.lead.name : null)
    : null;
  return {
    projectId,
    projectKey: typeof proj.key === 'string' ? proj.key : null,
    name: typeof proj.name === 'string' ? proj.name : null,
    description: typeof proj.description === 'string' ? proj.description : null,
    projectType: typeof proj.projectTypeKey === 'string' ? proj.projectTypeKey
      : typeof proj.style === 'string' ? proj.style : null,
    leadName: lead,
    url: typeof proj.self === 'string' ? proj.self : null,
  };
}

/**
 * Twitter bookmark mapper. Needs the includes.users join from the
 * SAME response to resolve author username — caller must build that
 * lookup once via extractTwitterUserIncludes and pass it as the
 * second arg. We expose the single-arg signature too because the init
 * fetcher wires the lookup itself.
 */
export function mapTwitterBookmark(
  tweet: any,
  authors: Record<string, { username?: string; name?: string }> = {},
): raw.TwitterBookmarkInput | null {
  if (!tweet || typeof tweet !== 'object') return null;
  const tweetId = String(tweet.id ?? tweet.tweet_id ?? '').trim();
  if (!tweetId) return null;
  const authorId = typeof tweet.author_id === 'string' ? tweet.author_id : null;
  const author = authorId ? authors[authorId] ?? null : null;
  const username = author?.username ?? null;
  return {
    tweetId,
    authorUsername: username,
    authorId,
    text: typeof tweet.text === 'string' ? tweet.text : null,
    lang: typeof tweet.lang === 'string' ? tweet.lang : null,
    createdAtRemote: typeof tweet.created_at === 'string' ? tweet.created_at : null,
    url: username ? `https://twitter.com/${username}/status/${tweetId}` : null,
  };
}

export function mapCalendlyEvent(evt: any): raw.CalendlyEventInput | null {
  if (!evt || typeof evt !== 'object') return null;
  const eventUri = String(evt.uri ?? evt.event_uri ?? '').trim();
  if (!eventUri) return null;
  const loc = evt.location && typeof evt.location === 'object' ? evt.location : null;
  // Calendly invitees live at /scheduled_events/{uuid}/invitees — we
  // don't fetch them per-event on init (would N+1 explode). Pull whatever
  // is inlined; common shape includes `event_memberships` for hosts.
  const invitees: Array<{ name?: string | null; email?: string | null }> = [];
  if (Array.isArray(evt.event_memberships)) {
    for (const m of evt.event_memberships) {
      if (m && typeof m === 'object') {
        invitees.push({
          name: typeof m.user_name === 'string' ? m.user_name : null,
          email: typeof m.user_email === 'string' ? m.user_email : null,
        });
      }
    }
  }
  return {
    eventUri,
    name: typeof evt.name === 'string' ? evt.name : null,
    status: typeof evt.status === 'string' ? evt.status : null,
    startAt: typeof evt.start_time === 'string' ? evt.start_time : null,
    endAt: typeof evt.end_time === 'string' ? evt.end_time : null,
    locationType: loc && typeof loc.type === 'string' ? loc.type : null,
    locationValue: loc && typeof loc.location === 'string' ? loc.location
      : loc && typeof loc.join_url === 'string' ? loc.join_url : null,
    invitees,
    meetingUrl: loc && typeof loc.join_url === 'string' ? loc.join_url : null,
  };
}

export function mapLinkedinProfile(profile: any): raw.LinkedinProfileInput | null {
  if (!profile || typeof profile !== 'object') return null;
  // LinkedIn returns localizedFirstName / localizedLastName as flat strings
  // when v2 /me is queried with default locale; otherwise nested under
  // firstName.localized.<locale>. Walk both shapes.
  const linkedinId = String(profile.id ?? profile.sub ?? profile.linkedin_id ?? '').trim();
  if (!linkedinId) return null;
  const firstName = typeof profile.localizedFirstName === 'string' ? profile.localizedFirstName
    : typeof profile.firstName?.localized === 'object'
      ? (Object.values(profile.firstName.localized)[0] as string | undefined)
      : typeof profile.firstName === 'string' ? profile.firstName : null;
  const lastName = typeof profile.localizedLastName === 'string' ? profile.localizedLastName
    : typeof profile.lastName?.localized === 'object'
      ? (Object.values(profile.lastName.localized)[0] as string | undefined)
      : typeof profile.lastName === 'string' ? profile.lastName : null;
  const headline = typeof profile.localizedHeadline === 'string' ? profile.localizedHeadline
    : typeof profile.headline === 'string' ? profile.headline : null;
  const picture = profile.profilePicture && typeof profile.profilePicture === 'object'
    ? (typeof profile.profilePicture.displayImage === 'string' ? profile.profilePicture.displayImage
       : typeof profile.profilePicture.original === 'string' ? profile.profilePicture.original : null)
    : (typeof profile.picture === 'string' ? profile.picture : null);
  return {
    linkedinId,
    firstName: firstName ?? null,
    lastName: lastName ?? null,
    localizedName: typeof profile.name === 'string' ? profile.name : null,
    headline: headline ?? null,
    vanityName: typeof profile.vanityName === 'string' ? profile.vanityName : null,
    pictureUrl: picture ?? null,
    profileUrl: typeof profile.profileUrl === 'string' ? profile.profileUrl : null,
  };
}

export function mapLinkedinOrganization(item: any): raw.LinkedinOrganizationInput | null {
  if (!item || typeof item !== 'object') return null;
  // The LINKEDIN_GET_COMPANY_INFO action returns "organizational entity
  // ACL" entries: { roleAssignee, role, state, organization, organizationalTarget }.
  // organization or organizationalTarget contains the URN; org details
  // (name, url) may be inlined or require a separate fetch — accept whichever shape.
  const orgUrn = String(
    item.organization
    ?? item.organizationalTarget
    ?? item.org_urn
    ?? item.urn
    ?? '',
  ).trim();
  if (!orgUrn) return null;
  const orgIdMatch = orgUrn.match(/(\d+)$/);
  const orgId = orgIdMatch ? orgIdMatch[1] : null;
  return {
    orgUrn,
    orgId,
    role: typeof item.role === 'string' ? item.role : null,
    roleState: typeof item.state === 'string' ? item.state
      : typeof item.role_state === 'string' ? item.role_state : null,
    orgName: typeof item.organizationName === 'string' ? item.organizationName
      : typeof item.org_name === 'string' ? item.org_name
      : typeof item.name === 'string' ? item.name : null,
    orgUrl: typeof item.organizationUrl === 'string' ? item.organizationUrl
      : typeof item.org_url === 'string' ? item.org_url : null,
    logoUrl: typeof item.logoUrl === 'string' ? item.logoUrl : null,
  };
}

export function mapFigmaUser(user: any): raw.FigmaUserInput | null {
  if (!user || typeof user !== 'object') return null;
  const figmaId = String(user.id ?? user.figma_id ?? '').trim();
  if (!figmaId) return null;
  return {
    figmaId,
    email: typeof user.email === 'string' ? user.email : null,
    handle: typeof user.handle === 'string' ? user.handle : null,
    imgUrl: typeof user.img_url === 'string' ? user.img_url
      : typeof user.imgUrl === 'string' ? user.imgUrl : null,
  };
}

export function mapZoomUser(user: any): raw.ZoomUserInput | null {
  if (!user || typeof user !== 'object') return null;
  const zoomId = String(user.id ?? user.zoom_id ?? '').trim();
  if (!zoomId) return null;
  // Zoom: type is integer (1=Basic, 2=Licensed, 3=On-prem). language is
  // localized string. department/role_name are admin-set fields.
  return {
    zoomId,
    email: typeof user.email === 'string' ? user.email : null,
    firstName: typeof user.first_name === 'string' ? user.first_name : null,
    lastName: typeof user.last_name === 'string' ? user.last_name : null,
    displayName: typeof user.display_name === 'string' ? user.display_name : null,
    accountType: typeof user.type === 'number' ? user.type
      : typeof user.account_type === 'number' ? user.account_type : null,
    roleName: typeof user.role_name === 'string' ? user.role_name : null,
    department: typeof user.dept === 'string' ? user.dept
      : typeof user.department === 'string' ? user.department : null,
    timezone: typeof user.timezone === 'string' ? user.timezone : null,
    location: typeof user.location === 'string' ? user.location : null,
    language: typeof user.language === 'string' ? user.language : null,
  };
}

export function mapZoomMarketplaceApp(app: any): raw.ZoomMarketplaceAppInput | null {
  if (!app || typeof app !== 'object') return null;
  // The unique identifier is the install (per-user instance), not the app
  // family. install_id || installation_id || id all show up depending on
  // Zoom's iteration of this endpoint.
  const appInstallId = String(
    app.install_id
    ?? app.installation_id
    ?? app.id
    ?? '',
  ).trim();
  if (!appInstallId) return null;
  return {
    appInstallId,
    appId: typeof app.app_id === 'string' ? app.app_id : null,
    name: typeof app.name === 'string' ? app.name : null,
    publisher: typeof app.publisher === 'string' ? app.publisher
      : typeof app.developer === 'string' ? app.developer : null,
    installState: typeof app.install_state === 'string' ? app.install_state
      : typeof app.state === 'string' ? app.state : null,
    appType: typeof app.app_type === 'string' ? app.app_type
      : typeof app.type === 'string' ? app.type : null,
    installedAt: typeof app.installed_on === 'string' ? app.installed_on
      : typeof app.installed_at === 'string' ? app.installed_at : null,
  };
}

export function mapDropboxAccount(account: any): raw.DropboxAccountInput | null {
  if (!account || typeof account !== 'object') return null;
  const accountId = String(account.account_id ?? account.account ?? '').trim();
  if (!accountId) return null;
  // name is nested {given_name, surname, familiar_name, display_name}.
  const name = account.name && typeof account.name === 'object' ? account.name : {};
  const accountTypeTag = account.account_type && typeof account.account_type === 'object'
    ? (typeof account.account_type['.tag'] === 'string' ? account.account_type['.tag'] : null)
    : (typeof account.account_type === 'string' ? account.account_type : null);
  return {
    accountId,
    email: typeof account.email === 'string' ? account.email : null,
    displayName: typeof name.display_name === 'string' ? name.display_name : null,
    givenName: typeof name.given_name === 'string' ? name.given_name : null,
    surname: typeof name.surname === 'string' ? name.surname : null,
    accountType: accountTypeTag,
    country: typeof account.country === 'string' ? account.country : null,
    locale: typeof account.locale === 'string' ? account.locale : null,
  };
}

export function mapDropboxFile(entry: any): raw.DropboxFileInput | null {
  if (!entry || typeof entry !== 'object') return null;
  // Dropbox `.tag` distinguishes file/folder. id starts with 'id:' for files,
  // folders also have ids. Use whichever exists.
  const fileId = String(entry.id ?? entry.path_lower ?? '').trim();
  if (!fileId) return null;
  const tag = typeof entry['.tag'] === 'string' ? entry['.tag'] : null;
  return {
    fileId,
    tag,
    name: typeof entry.name === 'string' ? entry.name : null,
    pathLower: typeof entry.path_lower === 'string' ? entry.path_lower : null,
    pathDisplay: typeof entry.path_display === 'string' ? entry.path_display : null,
    sizeBytes: typeof entry.size === 'number' ? entry.size : null,
    serverModified: typeof entry.server_modified === 'string' ? entry.server_modified : null,
    clientModified: typeof entry.client_modified === 'string' ? entry.client_modified : null,
    rev: typeof entry.rev === 'string' ? entry.rev : null,
    isDownloadable: entry.is_downloadable !== false,
  };
}

export function mapAsanaWorkspace(ws: any): raw.AsanaWorkspaceInput | null {
  if (!ws || typeof ws !== 'object') return null;
  const workspaceGid = String(ws.gid ?? ws.id ?? '').trim();
  if (!workspaceGid) return null;
  return {
    workspaceGid,
    name: typeof ws.name === 'string' ? ws.name : null,
    resourceType: typeof ws.resource_type === 'string' ? ws.resource_type : null,
    isOrganization: Boolean(ws.is_organization),
  };
}

export function mapAsanaTask(task: any, workspaceGid: string | null = null): raw.AsanaTaskInput | null {
  if (!task || typeof task !== 'object') return null;
  const taskGid = String(task.gid ?? task.id ?? '').trim();
  if (!taskGid) return null;
  // Pick first project gid from `projects` if present; tasks typically
  // belong to one but the API returns an array.
  const firstProject = Array.isArray(task.projects) && task.projects.length > 0
    ? (task.projects[0]?.gid ?? null)
    : null;
  return {
    taskGid,
    workspaceGid,
    projectGid: typeof firstProject === 'string' ? firstProject : null,
    name: typeof task.name === 'string' ? task.name : null,
    notes: typeof task.notes === 'string' ? task.notes : null,
    completed: Boolean(task.completed),
    assigneeStatus: typeof task.assignee_status === 'string' ? task.assignee_status : null,
    dueAt: typeof task.due_at === 'string' ? task.due_at : null,
    dueOn: typeof task.due_on === 'string' ? task.due_on : null,
    modifiedAtRemote: typeof task.modified_at === 'string' ? task.modified_at : null,
    createdAtRemote: typeof task.created_at === 'string' ? task.created_at : null,
  };
}

export function mapHubspotContact(contact: any): raw.HubspotContactInput | null {
  if (!contact || typeof contact !== 'object') return null;
  const contactId = String(contact.id ?? contact.contact_id ?? '').trim();
  if (!contactId) return null;
  // HubSpot search returns `{ id, properties: { email, firstname, ... },
  // createdAt, updatedAt }`. Pull from properties bag.
  const props = contact.properties && typeof contact.properties === 'object' ? contact.properties : {};
  return {
    contactId,
    email: typeof props.email === 'string' ? props.email : null,
    firstName: typeof props.firstname === 'string' ? props.firstname : null,
    lastName: typeof props.lastname === 'string' ? props.lastname : null,
    company: typeof props.company === 'string' ? props.company : null,
    jobtitle: typeof props.jobtitle === 'string' ? props.jobtitle : null,
    lifecycleStage: typeof props.lifecyclestage === 'string' ? props.lifecyclestage : null,
    leadStatus: typeof props.hs_lead_status === 'string' ? props.hs_lead_status : null,
    createdAtRemote: typeof contact.createdAt === 'string' ? contact.createdAt
      : typeof props.createdate === 'string' ? props.createdate : null,
    modifiedAtRemote: typeof contact.updatedAt === 'string' ? contact.updatedAt
      : typeof props.lastmodifieddate === 'string' ? props.lastmodifieddate : null,
  };
}

export function mapClickupUser(item: any): raw.ClickupUserInput | null {
  if (!item || typeof item !== 'object') return null;
  // ClickUp wraps under `{ user: {...} }`.
  const user = item.user && typeof item.user === 'object' ? item.user : item;
  const clickupId = String(user.id ?? user.user_id ?? '').trim();
  if (!clickupId) return null;
  return {
    clickupId,
    username: typeof user.username === 'string' ? user.username : null,
    email: typeof user.email === 'string' ? user.email : null,
    color: typeof user.color === 'string' ? user.color : null,
    profilePicture: typeof user.profilePicture === 'string' ? user.profilePicture
      : typeof user.profile_picture === 'string' ? user.profile_picture : null,
    timezone: typeof user.timezone === 'string' ? user.timezone : null,
  };
}

export function mapClickupWorkspace(team: any): raw.ClickupWorkspaceInput | null {
  if (!team || typeof team !== 'object') return null;
  const workspaceId = String(team.id ?? team.workspace_id ?? '').trim();
  if (!workspaceId) return null;
  const membersCount = Array.isArray(team.members) ? team.members.length : null;
  return {
    workspaceId,
    name: typeof team.name === 'string' ? team.name : null,
    color: typeof team.color === 'string' ? team.color : null,
    avatar: typeof team.avatar === 'string' ? team.avatar : null,
    membersCount,
  };
}

export function mapGdriveFile(file: any): raw.GdriveFileInput | null {
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

export function buildSignalsForInit(
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
    gdocsRows: raw.GdocsDocumentInput[];
    gdocsIds: string[];
    gsheetsRows: raw.GsheetsSpreadsheetInput[];
    gsheetsIds: string[];
    stripeRows: raw.StripeInvoiceInput[];
    stripeIds: string[];
    discordRows: raw.DiscordGuildInput[];
    discordIds: string[];
    spotifyRecentRows: raw.SpotifyRecentTrackInput[];
    spotifyRecentIds: string[];
    stravaRows: raw.StravaActivityInput[];
    stravaIds: string[];
    todoistRows: raw.TodoistTaskInput[];
    todoistIds: string[];
    youtubeSubsRows: raw.YoutubeSubscriptionInput[];
    youtubeSubsIds: string[];
    trelloRows: raw.TrelloBoardInput[];
    trelloIds: string[];
    jiraRows: raw.JiraProjectInput[];
    jiraIds: string[];
    twitterRows: raw.TwitterBookmarkInput[];
    twitterIds: string[];
    calendlyRows: raw.CalendlyEventInput[];
    calendlyIds: string[];
    linkedinProfileRows: raw.LinkedinProfileInput[];
    linkedinProfileIds: string[];
    linkedinOrgRows: raw.LinkedinOrganizationInput[];
    linkedinOrgIds: string[];
    figmaUserRows: raw.FigmaUserInput[];
    figmaUserIds: string[];
    zoomUserRows: raw.ZoomUserInput[];
    zoomUserIds: string[];
    zoomAppRows: raw.ZoomMarketplaceAppInput[];
    zoomAppIds: string[];
    dropboxAccountRows: raw.DropboxAccountInput[];
    dropboxAccountIds: string[];
    dropboxFileRows: raw.DropboxFileInput[];
    dropboxFileIds: string[];
    asanaWorkspaceRows: raw.AsanaWorkspaceInput[];
    asanaWorkspaceIds: string[];
    asanaTaskRows: raw.AsanaTaskInput[];
    asanaTaskIds: string[];
    hubspotContactRows: raw.HubspotContactInput[];
    hubspotContactIds: string[];
    clickupUserRows: raw.ClickupUserInput[];
    clickupUserIds: string[];
    clickupWorkspaceRows: raw.ClickupWorkspaceInput[];
    clickupWorkspaceIds: string[];
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
  for (let i = 0; i < buckets.gdocsIds.length; i += 1) {
    const row = buckets.gdocsRows[i];
    if (!row) continue;
    const title = trimSummary(row.name ?? '(unnamed document)', 120);
    const summary = trimSummary(row.webViewLink ?? title, 280) || title;
    out.push({
      kind: 'connector.googledocs.document',
      title,
      summary,
      payload: { webViewLink: row.webViewLink, owners: row.owners, lastModifyingUser: row.lastModifyingUser },
      source: `connector:${toolkit}`,
      sourceRawTable: 'gdocs_documents',
      sourceRawIds: [buckets.gdocsIds[i]!],
      occurredAt: row.modifiedTime ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.documentId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.gsheetsIds.length; i += 1) {
    const row = buckets.gsheetsRows[i];
    if (!row) continue;
    const title = trimSummary(row.name ?? '(unnamed spreadsheet)', 120);
    const summary = trimSummary(row.webViewLink ?? title, 280) || title;
    out.push({
      kind: 'connector.googlesheets.spreadsheet',
      title,
      summary,
      payload: { webViewLink: row.webViewLink, owners: row.owners, lastModifyingUser: row.lastModifyingUser },
      source: `connector:${toolkit}`,
      sourceRawTable: 'gsheets_spreadsheets',
      sourceRawIds: [buckets.gsheetsIds[i]!],
      occurredAt: row.modifiedTime ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.spreadsheetId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.stripeIds.length; i += 1) {
    const row = buckets.stripeRows[i];
    if (!row) continue;
    const customerLabel = row.customerName ?? row.customerEmail ?? row.customerId ?? 'unknown';
    const amountLabel = row.amountDue != null && row.currency
      ? `${(row.amountDue / 100).toFixed(2)} ${row.currency.toUpperCase()}`
      : '';
    const title = trimSummary(`Invoice ${row.number ?? row.invoiceId} · ${customerLabel}${amountLabel ? ` · ${amountLabel}` : ''}`, 120);
    const summary = trimSummary(`status=${row.status ?? '?'} · ${row.hostedInvoiceUrl ?? title}`, 280) || title;
    out.push({
      kind: 'connector.stripe.invoice',
      title,
      summary,
      payload: {
        status: row.status, customerId: row.customerId,
        amountDue: row.amountDue, amountPaid: row.amountPaid, currency: row.currency,
        hostedInvoiceUrl: row.hostedInvoiceUrl,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'stripe_invoices',
      sourceRawIds: [buckets.stripeIds[i]!],
      occurredAt: row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.invoiceId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.discordIds.length; i += 1) {
    const row = buckets.discordRows[i];
    if (!row) continue;
    const memberLabel = row.approximateMemberCount != null
      ? ` · ${row.approximateMemberCount} members`
      : '';
    const title = trimSummary(`#${row.name ?? row.guildId}${memberLabel}`, 120);
    const summary = trimSummary(
      `${row.isOwner ? 'owner' : 'member'}${row.features && row.features.length ? ` · features: ${row.features.slice(0, 3).join(', ')}` : ''}`,
      280,
    ) || title;
    out.push({
      kind: 'connector.discord.guild',
      title,
      summary,
      payload: {
        isOwner: row.isOwner, memberCount: row.approximateMemberCount,
        presenceCount: row.approximatePresenceCount, features: row.features,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'discord_guilds',
      sourceRawIds: [buckets.discordIds[i]!],
      // Discord doesn't have a per-guild "occurred" time; leave undefined → defaults to now
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.guildId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.spotifyRecentIds.length; i += 1) {
    const row = buckets.spotifyRecentRows[i];
    if (!row) continue;
    const artistLabel = row.artistNames && row.artistNames.length > 0
      ? row.artistNames.slice(0, 3).join(', ')
      : 'unknown artist';
    const title = trimSummary(`${row.trackName ?? '(untitled)'} — ${artistLabel}`, 120);
    const summary = trimSummary(
      [
        row.albumName ? `Album: ${row.albumName}` : null,
        row.contextType ? `Context: ${row.contextType}` : null,
      ].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.spotify.played_track',
      title,
      summary,
      payload: {
        trackId: row.trackId,
        artists: row.artistNames,
        album: row.albumName,
        contextType: row.contextType,
        contextUri: row.contextUri,
        durationMs: row.durationMs,
        popularity: row.popularity,
        url: row.trackUrl,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'spotify_recent_tracks',
      sourceRawIds: [buckets.spotifyRecentIds[i]!],
      occurredAt: row.playedAt,
      // Same track played at the same instant on two pulls dedupes; replays
      // at different times produce distinct signals.
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.trackId}:${row.playedAt}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.stravaIds.length; i += 1) {
    const row = buckets.stravaRows[i];
    if (!row) continue;
    const distKm = typeof row.distanceMeters === 'number'
      ? `${(row.distanceMeters / 1000).toFixed(1)}km`
      : null;
    const title = trimSummary(`${row.activityType ?? 'Activity'} · ${row.name ?? '(untitled)'}`, 120);
    const summary = trimSummary(
      [distKm, row.movingTimeSeconds ? `${Math.round(row.movingTimeSeconds / 60)}min` : null].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.strava.activity',
      title,
      summary,
      payload: {
        type: row.activityType,
        distanceMeters: row.distanceMeters,
        movingTimeSeconds: row.movingTimeSeconds,
        elevationGainMeters: row.elevationGainMeters,
        averageHeartrate: row.averageHeartrate,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'strava_activities',
      sourceRawIds: [buckets.stravaIds[i]!],
      occurredAt: row.startDate ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.activityId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.todoistIds.length; i += 1) {
    const row = buckets.todoistRows[i];
    if (!row) continue;
    const title = trimSummary(row.content ?? '(untitled task)', 120);
    const summary = trimSummary(row.description ?? row.content ?? title, 280) || title;
    out.push({
      kind: 'connector.todoist.task',
      title,
      summary,
      payload: {
        projectId: row.projectId,
        priority: row.priority,
        labels: row.labels,
        dueAt: row.dueAt,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'todoist_tasks',
      sourceRawIds: [buckets.todoistIds[i]!],
      occurredAt: row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.taskId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.youtubeSubsIds.length; i += 1) {
    const row = buckets.youtubeSubsRows[i];
    if (!row) continue;
    const title = trimSummary(row.channelTitle ?? row.channelId, 120);
    const summary = trimSummary(row.channelDescription ?? title, 280) || title;
    out.push({
      kind: 'connector.youtube.subscription',
      title,
      summary,
      payload: { channelId: row.channelId },
      source: `connector:${toolkit}`,
      sourceRawTable: 'youtube_subscriptions',
      sourceRawIds: [buckets.youtubeSubsIds[i]!],
      occurredAt: row.subscribedAt ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.subscriptionId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.trelloIds.length; i += 1) {
    const row = buckets.trelloRows[i];
    if (!row) continue;
    const flags = [
      row.starred ? 'starred' : null,
      row.pinned ? 'pinned' : null,
      row.closed ? 'closed' : null,
    ].filter(Boolean).join(', ');
    const title = trimSummary(row.name ?? row.boardId, 120);
    const summary = trimSummary(
      [row.description, flags ? `(${flags})` : null].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.trello.board',
      title,
      summary,
      payload: {
        organizationId: row.organizationId,
        starred: row.starred, pinned: row.pinned, closed: row.closed,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'trello_boards',
      sourceRawIds: [buckets.trelloIds[i]!],
      occurredAt: row.lastActivityAt ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.boardId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.jiraIds.length; i += 1) {
    const row = buckets.jiraRows[i];
    if (!row) continue;
    const title = trimSummary(`[${row.projectKey ?? '?'}] ${row.name ?? '(unnamed project)'}`, 120);
    const summary = trimSummary(row.description ?? title, 280) || title;
    out.push({
      kind: 'connector.jira.project',
      title,
      summary,
      payload: { projectKey: row.projectKey, projectType: row.projectType, leadName: row.leadName },
      source: `connector:${toolkit}`,
      sourceRawTable: 'jira_projects',
      sourceRawIds: [buckets.jiraIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.projectId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.twitterIds.length; i += 1) {
    const row = buckets.twitterRows[i];
    if (!row) continue;
    const author = row.authorUsername ? `@${row.authorUsername}` : '(unknown)';
    const title = trimSummary(`${author}: ${row.text ?? ''}`, 120);
    const summary = trimSummary(row.text ?? title, 280) || title;
    out.push({
      kind: 'connector.twitter.bookmark',
      title,
      summary,
      payload: { authorUsername: row.authorUsername, lang: row.lang, url: row.url },
      source: `connector:${toolkit}`,
      sourceRawTable: 'twitter_bookmarks',
      sourceRawIds: [buckets.twitterIds[i]!],
      occurredAt: row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.tweetId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.calendlyIds.length; i += 1) {
    const row = buckets.calendlyRows[i];
    if (!row) continue;
    const inviteeNames = (row.invitees ?? [])
      .map((inv) => inv?.name ?? inv?.email ?? null)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, 5);
    const title = trimSummary(row.name ?? '(untitled event)', 120);
    const summary = trimSummary(
      [
        inviteeNames.length > 0 ? `with ${inviteeNames.join(', ')}` : null,
        row.locationType ? `via ${row.locationType}` : null,
      ].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.calendly.event',
      title,
      summary,
      payload: {
        status: row.status,
        startAt: row.startAt, endAt: row.endAt,
        locationType: row.locationType,
        meetingUrl: row.meetingUrl,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'calendly_events',
      sourceRawIds: [buckets.calendlyIds[i]!],
      occurredAt: row.startAt ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.eventUri}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.linkedinProfileIds.length; i += 1) {
    const row = buckets.linkedinProfileRows[i];
    if (!row) continue;
    const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ') || row.localizedName || '(unknown)';
    const title = trimSummary(`LinkedIn: ${fullName}`, 120);
    const summary = trimSummary(row.headline ?? title, 280) || title;
    out.push({
      kind: 'connector.linkedin.profile',
      title, summary,
      payload: { vanityName: row.vanityName, profileUrl: row.profileUrl },
      source: `connector:${toolkit}`,
      sourceRawTable: 'linkedin_profile',
      sourceRawIds: [buckets.linkedinProfileIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.linkedinId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.linkedinOrgIds.length; i += 1) {
    const row = buckets.linkedinOrgRows[i];
    if (!row) continue;
    const title = trimSummary(`${row.role ?? 'role'} at ${row.orgName ?? row.orgUrn}`, 120);
    const summary = trimSummary(
      [row.roleState ? `(${row.roleState})` : null, row.orgUrl].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.linkedin.organization',
      title, summary,
      payload: { role: row.role, roleState: row.roleState, orgUrl: row.orgUrl },
      source: `connector:${toolkit}`,
      sourceRawTable: 'linkedin_organizations',
      sourceRawIds: [buckets.linkedinOrgIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.orgUrn}:${row.role ?? '_'}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.figmaUserIds.length; i += 1) {
    const row = buckets.figmaUserRows[i];
    if (!row) continue;
    const title = trimSummary(`Figma: @${row.handle ?? row.email ?? row.figmaId}`, 120);
    const summary = trimSummary(row.email ?? title, 280) || title;
    out.push({
      kind: 'connector.figma.user',
      title, summary,
      payload: { handle: row.handle, email: row.email },
      source: `connector:${toolkit}`,
      sourceRawTable: 'figma_user',
      sourceRawIds: [buckets.figmaUserIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.figmaId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.zoomUserIds.length; i += 1) {
    const row = buckets.zoomUserRows[i];
    if (!row) continue;
    const accountTypeLabel = row.accountType === 1 ? 'Basic'
      : row.accountType === 2 ? 'Licensed'
      : row.accountType === 3 ? 'On-prem' : '?';
    const title = trimSummary(`Zoom: ${row.displayName ?? row.email ?? row.zoomId} (${accountTypeLabel})`, 120);
    const summary = trimSummary(
      [row.department, row.timezone].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.zoom.user',
      title, summary,
      payload: { accountType: row.accountType, department: row.department, timezone: row.timezone },
      source: `connector:${toolkit}`,
      sourceRawTable: 'zoom_user',
      sourceRawIds: [buckets.zoomUserIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.zoomId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.zoomAppIds.length; i += 1) {
    const row = buckets.zoomAppRows[i];
    if (!row) continue;
    const title = trimSummary(`Zoom app: ${row.name ?? row.appId ?? '(unknown)'}`, 120);
    const summary = trimSummary(
      [row.publisher, row.installState].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.zoom.app',
      title, summary,
      payload: { publisher: row.publisher, installState: row.installState, appType: row.appType },
      source: `connector:${toolkit}`,
      sourceRawTable: 'zoom_marketplace_apps',
      sourceRawIds: [buckets.zoomAppIds[i]!],
      occurredAt: row.installedAt ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.appInstallId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.dropboxAccountIds.length; i += 1) {
    const row = buckets.dropboxAccountRows[i];
    if (!row) continue;
    const title = trimSummary(`Dropbox: ${row.displayName ?? row.email ?? row.accountId} (${row.accountType ?? '?'})`, 120);
    const summary = trimSummary(
      [row.email, row.country, row.locale].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.dropbox.account',
      title, summary,
      payload: { accountType: row.accountType, country: row.country },
      source: `connector:${toolkit}`,
      sourceRawTable: 'dropbox_account',
      sourceRawIds: [buckets.dropboxAccountIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.accountId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.dropboxFileIds.length; i += 1) {
    const row = buckets.dropboxFileRows[i];
    if (!row) continue;
    const title = trimSummary(`${row.tag === 'folder' ? '📁' : '📄'} ${row.name ?? row.pathDisplay ?? row.fileId}`, 120);
    const summary = trimSummary(
      [row.pathDisplay, typeof row.sizeBytes === 'number' ? `${row.sizeBytes}B` : null].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.dropbox.file',
      title, summary,
      payload: { tag: row.tag, pathDisplay: row.pathDisplay, sizeBytes: row.sizeBytes },
      source: `connector:${toolkit}`,
      sourceRawTable: 'dropbox_files',
      sourceRawIds: [buckets.dropboxFileIds[i]!],
      occurredAt: row.serverModified ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.fileId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.asanaWorkspaceIds.length; i += 1) {
    const row = buckets.asanaWorkspaceRows[i];
    if (!row) continue;
    const title = trimSummary(`Asana workspace: ${row.name ?? row.workspaceGid}`, 120);
    out.push({
      kind: 'connector.asana.workspace',
      title, summary: title,
      payload: { isOrganization: row.isOrganization },
      source: `connector:${toolkit}`,
      sourceRawTable: 'asana_workspaces',
      sourceRawIds: [buckets.asanaWorkspaceIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.workspaceGid}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.asanaTaskIds.length; i += 1) {
    const row = buckets.asanaTaskRows[i];
    if (!row) continue;
    const title = trimSummary(row.name ?? '(untitled task)', 120);
    const summary = trimSummary(row.notes ?? title, 280) || title;
    out.push({
      kind: 'connector.asana.task',
      title, summary,
      payload: {
        completed: row.completed, assigneeStatus: row.assigneeStatus,
        workspaceGid: row.workspaceGid, projectGid: row.projectGid, dueOn: row.dueOn,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'asana_tasks',
      sourceRawIds: [buckets.asanaTaskIds[i]!],
      occurredAt: row.modifiedAtRemote ?? row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.taskGid}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.hubspotContactIds.length; i += 1) {
    const row = buckets.hubspotContactRows[i];
    if (!row) continue;
    const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email || '(unknown)';
    const title = trimSummary(`HubSpot: ${fullName}${row.company ? ` @ ${row.company}` : ''}`, 120);
    const summary = trimSummary(
      [row.jobtitle, row.lifecycleStage, row.leadStatus].filter(Boolean).join(' · ') || title,
      280,
    ) || title;
    out.push({
      kind: 'connector.hubspot.contact',
      title, summary,
      payload: {
        email: row.email, company: row.company,
        lifecycleStage: row.lifecycleStage, leadStatus: row.leadStatus,
      },
      source: `connector:${toolkit}`,
      sourceRawTable: 'hubspot_contacts',
      sourceRawIds: [buckets.hubspotContactIds[i]!],
      occurredAt: row.modifiedAtRemote ?? row.createdAtRemote ?? undefined,
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.contactId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.clickupUserIds.length; i += 1) {
    const row = buckets.clickupUserRows[i];
    if (!row) continue;
    const title = trimSummary(`ClickUp: ${row.username ?? row.email ?? row.clickupId}`, 120);
    const summary = trimSummary(row.email ?? title, 280) || title;
    out.push({
      kind: 'connector.clickup.user',
      title, summary,
      payload: { email: row.email, timezone: row.timezone },
      source: `connector:${toolkit}`,
      sourceRawTable: 'clickup_user',
      sourceRawIds: [buckets.clickupUserIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.clickupId}:init:v1`,
    });
  }
  for (let i = 0; i < buckets.clickupWorkspaceIds.length; i += 1) {
    const row = buckets.clickupWorkspaceRows[i];
    if (!row) continue;
    const title = trimSummary(`ClickUp workspace: ${row.name ?? row.workspaceId}`, 120);
    const summary = trimSummary(
      typeof row.membersCount === 'number' ? `${row.membersCount} members` : title,
      280,
    ) || title;
    out.push({
      kind: 'connector.clickup.workspace',
      title, summary,
      payload: { membersCount: row.membersCount },
      source: `connector:${toolkit}`,
      sourceRawTable: 'clickup_workspaces',
      sourceRawIds: [buckets.clickupWorkspaceIds[i]!],
      dedupeKey: `connector:${toolkit}:${connectedAccountId}:${row.workspaceId}:init:v1`,
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Misc
// ──────────────────────────────────────────────────────────────────────

export function isSupportedToolkit(t: string): t is SupportedToolkit {
  return (SUPPORTED_TOOLKITS as readonly string[]).includes(t);
}

export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function parseDisabledToolkits(): Set<string> {
  const raw = process.env.CONNECTOR_INIT_DISABLED_TOOLKITS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function trimSummary(value: string | null | undefined, maxLen: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 3) + '...' : trimmed;
}

export function failHard(code: string, message: string): TaskHandlerResult {
  return { status: 'failed', errorCode: code, errorMessage: message };
}

export function abortLeaseLost(stage: string): TaskHandlerResult {
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

export function makeDefaultFetcher(apiKey: string): ComposioFetcher {
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

export function safeJsonParse(text: string): unknown {
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

export function formatComposioError(data: unknown): string | null {
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
