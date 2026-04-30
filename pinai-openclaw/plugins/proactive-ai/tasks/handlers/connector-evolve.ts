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
import crypto from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import * as db from '../../db.js';
import * as raw from '../../raw-db.js';
import { runAgent, parseAgentJson } from '../../pipeline/agent-runner.js';
import type { TaskLogger } from '../scheduler.js';

const MAX_PROMPT_ITEMS = 20;
// Recent-memory snapshot pool given to the agent for dedup. Subject-only
// dedup misses rephrasings (e.g. "tech stack: Foo, Bar" being re-emitted as
// "User knows Foo and Bar"); a 60-row snapshot with id + 200-char excerpt
// lets the agent compare full text and either skip or supersede.
const MAX_RECENT_MEMORY_SNAPSHOTS = 60;
const MEMORY_SNAPSHOT_TEXT_LEN = 200;
const MAX_TEXT_LEN_PER_ITEM = 320;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_SKILL_CANDIDATES = 3;
const MAX_SKILL_TITLE_LEN = 120;
const MAX_SKILL_DESCRIPTION_LEN = 300;
const MAX_SKILL_BODY_LEN = 1800;
const MIN_SKILL_CONFIDENCE = 0.65;

const NOOP_LOGGER: TaskLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type EvolveToolkit =
  | 'gmail' | 'googlecalendar'
  // Phase D round 1
  | 'slack' | 'notion' | 'googledrive'
  // Phase D round 2
  | 'github' | 'outlook'
  // Phase D round 3
  | 'googledocs' | 'googlesheets' | 'stripe' | 'discord'
  // Phase D round 4
  | 'spotify'
  | 'strava' | 'todoist' | 'youtube' | 'trello' | 'jira' | 'twitter' | 'calendly'
  // Phase D round 5
  | 'linkedin' | 'figma' | 'zoom' | 'dropbox' | 'asana' | 'hubspot' | 'clickup';

export interface ConnectorEvolveOpts {
  toolkit: EvolveToolkit;
  evolutionRunId: string;
  /**
   * The Composio connected_account_id this batch came from. Surfaced into
   * the prompt so the LLM knows "this is one of possibly several accounts
   * of this toolkit" — without it, the second Gmail account is almost
   * always full-dedup'd against the first account's memories and writes
   * nothing. With it the LLM can emit account-scoped memories (e.g.
   * "account A is the user's work email; account B is personal").
   *
   * Optional so tests can omit. When present we also include the last 6
   * chars in the user prompt so the LLM has a concrete account label to
   * cite in its emitted memory text without leaking the full id.
   */
  connectedAccountId?: string;
  /**
   * Items that were just freshly inserted into raw.db. We re-sample these
   * for the prompt; passing all 100 would blow the context budget.
   */
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
  skillsAdded: number;
  skillIds: string[];
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
  /** Existing memory id this new row replaces. Optional; when set, we mark
   *  the old row status='superseded' after the new row is written. */
  supersedes?: unknown;
}

interface AgentSkillWrite {
  title?: unknown;
  description?: unknown;
  triggers?: unknown;
  bodyMarkdown?: unknown;
  body_md?: unknown;
  body?: unknown;
  confidence?: unknown;
}

interface AgentMemoryEnvelope {
  memories?: AgentMemoryWrite[];
  skills?: AgentSkillWrite[];
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
      skillsAdded: 0,
      skillIds: [],
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
      skillsAdded: 0,
      skillIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: false,
      itemsSampled: 0,
    };
  }

  const profile = await db.getProfile().catch(() => null);
  const recentMemories = await snapshotRecentMemories().catch(() => []);

  const systemPrompt = buildSystemPrompt(opts.toolkit);
  const userMessage = buildUserMessage(
    opts.toolkit,
    sampled,
    profile,
    recentMemories,
    opts.connectedAccountId ?? null,
  );

  let agentText: string;
  try {
    agentText = await agentRun(systemPrompt, userMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[connector-evolve] agent call failed: ${msg}`);
    return {
      memoriesWritten: 0,
      memoryIds: [],
      skillsAdded: 0,
      skillIds: [],
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
      skillsAdded: 0,
      skillIds: [],
      durationMs: Date.now() - startedAt,
      llmFailed: true,
      llmError: 'agent output not parseable as JSON',
      itemsSampled: sampled.totalItems,
    };
  }

  const writes = sanitizeMemoryWrites(parsed.memories);
  const memoryIds: string[] = [];
  let supersededCount = 0;
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
      if (w.supersedes) {
        // Mark the prior row status='superseded'. If the agent supplied a
        // bogus id (hallucinated, or already archived), don't sink the
        // whole batch — log and continue.
        try {
          await db.supersedeMemoryV3(w.supersedes, row.id);
          supersededCount++;
        } catch (err) {
          logger.warn(`[connector-evolve] supersede ${w.supersedes} -> ${row.id} skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      // One bad row shouldn't sink the rest. Log and continue.
      logger.warn(`[connector-evolve] memory write rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const skillWrites = sanitizeSkillWrites(parsed.skills);
  const skillIds: string[] = [];
  for (const w of skillWrites) {
    try {
      const row = await db.addSkill({
        id: makeGeneratedSkillId(opts.toolkit),
        title: w.title,
        body: w.body,
        description: w.description,
        triggers: w.triggers,
        source: `connector_init:${opts.toolkit}`,
        createdRunId: opts.evolutionRunId,
        status: 'enabled',
      });
      skillIds.push(row.id);
    } catch (err) {
      logger.warn(`[connector-evolve] skill write rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (memoryIds.length > 0) {
    await db.recordEvolutionDelta(opts.evolutionRunId, {
      memoriesWritten: memoryIds.length,
      memoriesSuperseded: supersededCount > 0 ? supersededCount : undefined,
    });
    await db.recordEvolutionRefsProduced(opts.evolutionRunId, 'memory', memoryIds);
    await db.markMemoryReferenced(memoryIds, opts.evolutionRunId);
  }
  if (skillIds.length > 0) {
    await db.recordEvolutionDelta(opts.evolutionRunId, { skillsAdded: skillIds.length });
    await db.recordEvolutionRefsProduced(opts.evolutionRunId, 'skill_index', skillIds);
    await db.markSkillReferenced(skillIds, opts.evolutionRunId);
  }

  return {
    memoriesWritten: memoryIds.length,
    memoryIds,
    skillsAdded: skillIds.length,
    skillIds,
    durationMs: Date.now() - startedAt,
    llmFailed: false,
    itemsSampled: sampled.totalItems,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Prompt construction
// ──────────────────────────────────────────────────────────────────────

function buildSystemPrompt(toolkit: string): string {
  return `You extract DURABLE NEW user facts from a fresh batch of ${toolkit} items the user just connected. Output is a single JSON object inside one fenced \`\`\`json block, with this shape:

{
  "memories": [
    {
      "text": "Short factual sentence about the user (≤200 chars).",
      "subject": "topic:<key>" | "work:<key>" | "person:<name>" | "preference:<key>" | null,
      "quality": 0.4-0.85,
      "confidence": 0.0-1.0,
      "tags": ["string", ...],
      "supersedes": "<existing memory id from \\"Existing memories\\" block>" | null
    }
  ],
  "skills": [
    {
      "title": "Short action-led reusable instruction title.",
      "description": "One sentence explaining when this skill is useful.",
      "triggers": ["When X recurring situation appears", "..."],
      "bodyMarkdown": "## When to use\\n...\\n\\n## How to respond\\n- ...",
      "confidence": 0.65-1.0
    }
  ]
}

Rules:
- Capture stable things: ongoing projects, recurring contacts, expressed interests, role/employer hints, schedule patterns. NOT one-off events.
- Skip noise: newsletters, automated notifications, OAuth confirmations, password resets, marketing emails the user hasn't engaged with.
- Quality calibration (3 buckets — never above 0.85):
    * 0.40-0.55: inferred from indirect signal (e.g. "user probably interested in X because they receive newsletters about it").
    * 0.55-0.70: clearly observable in source (e.g. "user sent a Slack message saying X", "calendar shows recurring meeting").
    * 0.70-0.85: user-stated about themselves (resume claims, profile facts, explicit preferences expressed in writing).
- Confidence: how sure the fact is correct (separate from durability).
- Subject is a stable scoped key for de-duplication; reuse existing subjects from "Existing memories" when they apply.
- DEDUP IS HARD RULE: scan the "Existing memories" block (id + subject + text excerpt). If a candidate fact is the same as an existing row in meaning even when phrased differently, do ONE of:
    a. SKIP it (no new row).
    b. If you have NEW information that replaces the old fact (e.g. updated role, new employer), emit the new row AND set "supersedes" to the existing memory id. The old row will be archived.
  Examples to skip: "User knows ERC-4337 and RAG" when an existing memory already lists those tech stacks. Just rephrasing is not new information.
- Output valid JSON only. If nothing genuinely new is extractable: { "memories": [] }. An empty result is preferable to a duplicate.
- Skills are reusable procedures, not facts. Emit a skill only when the fresh connector data shows a recurring workflow or stable response pattern the assistant should reuse later.
- Do NOT turn generic profile facts into skills. "User uses Zoom" is a memory, not a skill. "Before investor meetings, gather recent investor docs and open questions" can be a skill if grounded by evidence.
- Emit at most ${MAX_SKILL_CANDIDATES} skills. Use "skills": [] unless confidence is at least ${MIN_SKILL_CONFIDENCE}.
- No prose outside the json fence. Quote any internal quotes with 「」 or escape with \\".

Multi-account note: a single ${toolkit} toolkit may be connected with TWO OR MORE accounts (e.g. user has a work Gmail and a personal Gmail). Earlier accounts have already produced person-level facts. For SUBSEQUENT accounts of the same toolkit, person-level facts will mostly dedup — that is expected and correct. Look INSTEAD for account-specific patterns:
- If items in this batch suggest the account is used for a particular CONTEXT (e.g. "this account receives mostly work / billing / newsletter / family / school traffic"), emit ONE concise memory naming that pattern. Subject like "account:<toolkit>:<short_id>" and reference the short id (last 6 chars) supplied below in "Account label". Example: "Gmail account ending …a1b2c3 is primarily used for finance/billing emails (Stripe, Plaid, banks)."
- If the items reveal a NEW employer / school / role / city not yet in memory, emit it normally (with supersedes if updating an existing role).
- Otherwise it is OK to return { "memories": [] } — silent dedup is correct.`;
}

interface SampledBundle {
  totalItems: number;
  gmail: Array<{ from?: string; subject?: string; snippet?: string; date?: string }>;
  gcal: Array<{ title?: string; start?: string; attendees?: string[] }>;
  slack: Array<{ user?: string; channel?: string; text?: string; date?: string }>;
  notion: Array<{ title?: string; preview?: string; edited?: string; parentType?: string }>;
  gdrive: Array<{ name?: string; mimeType?: string; modified?: string; owners?: string[] }>;
  github: Array<{ repo?: string; number?: number; title?: string; state?: string; isPR?: boolean; updated?: string; labels?: string[] }>;
  outlook: Array<{ from?: string; subject?: string; preview?: string; received?: string }>;
  gdocs: Array<{ name?: string; modified?: string; owners?: string[]; lastModifyingUser?: string }>;
  gsheets: Array<{ name?: string; modified?: string; owners?: string[]; lastModifyingUser?: string }>;
  stripe: Array<{ number?: string; status?: string; amountDue?: number; currency?: string; customer?: string; created?: string }>;
  discord: Array<{ name?: string; isOwner?: boolean; memberCount?: number; features?: string[] }>;
  spotifyRecent: Array<{ track?: string; artists?: string[]; album?: string; context?: string; playedAt?: string }>;
  stravaActivities: Array<{ name?: string; type?: string; distanceKm?: number; movingMin?: number; startDate?: string }>;
  todoistTasks: Array<{ content?: string; description?: string; priority?: number; labels?: string[]; dueAt?: string }>;
  youtubeSubs: Array<{ title?: string; description?: string }>;
  trelloBoards: Array<{ name?: string; description?: string; starred?: boolean; closed?: boolean }>;
  jiraProjects: Array<{ key?: string; name?: string; description?: string; type?: string }>;
  twitterBookmarks: Array<{ author?: string; text?: string; lang?: string; createdAt?: string }>;
  calendlyEvents: Array<{ name?: string; status?: string; startAt?: string; invitees?: string[] }>;
  linkedinProfile: Array<{ name?: string; headline?: string; vanityName?: string }>;
  linkedinOrgs: Array<{ orgName?: string; role?: string; roleState?: string }>;
  figmaUser: Array<{ handle?: string; email?: string }>;
  zoomUser: Array<{ name?: string; email?: string; accountType?: string; department?: string; timezone?: string }>;
  zoomApps: Array<{ name?: string; publisher?: string; appType?: string }>;
  dropboxAccount: Array<{ email?: string; displayName?: string; accountType?: string; country?: string }>;
  dropboxFiles: Array<{ name?: string; tag?: string; pathDisplay?: string; sizeBytes?: number }>;
  asanaWorkspaces: Array<{ name?: string; isOrganization?: boolean }>;
  asanaTasks: Array<{ name?: string; notes?: string; completed?: boolean; dueOn?: string }>;
  hubspotContacts: Array<{ name?: string; email?: string; company?: string; jobtitle?: string; lifecycleStage?: string }>;
  clickupUser: Array<{ username?: string; email?: string }>;
  clickupWorkspaces: Array<{ name?: string; membersCount?: number }>;
}

function sampleItems(opts: ConnectorEvolveOpts): SampledBundle {
  const gmail: SampledBundle['gmail'] = [];
  const gcal: SampledBundle['gcal'] = [];
  const slack: SampledBundle['slack'] = [];
  const notion: SampledBundle['notion'] = [];
  const gdrive: SampledBundle['gdrive'] = [];
  const github: SampledBundle['github'] = [];
  const outlook: SampledBundle['outlook'] = [];
  const gdocs: SampledBundle['gdocs'] = [];
  const gsheets: SampledBundle['gsheets'] = [];
  const stripe: SampledBundle['stripe'] = [];
  const discord: SampledBundle['discord'] = [];
  const spotifyRecent: SampledBundle['spotifyRecent'] = [];
  const stravaActivities: SampledBundle['stravaActivities'] = [];
  const todoistTasks: SampledBundle['todoistTasks'] = [];
  const youtubeSubs: SampledBundle['youtubeSubs'] = [];
  const trelloBoards: SampledBundle['trelloBoards'] = [];
  const jiraProjects: SampledBundle['jiraProjects'] = [];
  const twitterBookmarks: SampledBundle['twitterBookmarks'] = [];
  const calendlyEvents: SampledBundle['calendlyEvents'] = [];
  const linkedinProfile: SampledBundle['linkedinProfile'] = [];
  const linkedinOrgs: SampledBundle['linkedinOrgs'] = [];
  const figmaUser: SampledBundle['figmaUser'] = [];
  const zoomUser: SampledBundle['zoomUser'] = [];
  const zoomApps: SampledBundle['zoomApps'] = [];
  const dropboxAccount: SampledBundle['dropboxAccount'] = [];
  const dropboxFiles: SampledBundle['dropboxFiles'] = [];
  const asanaWorkspaces: SampledBundle['asanaWorkspaces'] = [];
  const asanaTasks: SampledBundle['asanaTasks'] = [];
  const hubspotContacts: SampledBundle['hubspotContacts'] = [];
  const clickupUser: SampledBundle['clickupUser'] = [];
  const clickupWorkspaces: SampledBundle['clickupWorkspaces'] = [];

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

  if (opts.github && opts.github.length > 0) {
    const sortedGithub = [...opts.github]
      .sort(byDescUpdatedAtRemote)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((i) => ({
        repo: i.repoFullName ?? undefined,
        number: typeof i.number === 'number' ? i.number : undefined,
        title: truncate(i.title ?? '', 120),
        state: i.state ?? undefined,
        isPR: Boolean(i.isPullRequest),
        updated: i.updatedAtRemote ?? undefined,
        labels: Array.isArray(i.labels) ? i.labels.slice(0, 6) : [],
      }));
    github.push(...sortedGithub);
  }
  if (opts.outlook && opts.outlook.length > 0) {
    const sortedOutlook = [...opts.outlook]
      .sort(byDescReceivedAt)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((m) => ({
        from: m.from ?? undefined,
        subject: truncate(m.subject ?? '', 120),
        preview: truncate(m.bodyPreview ?? '', MAX_TEXT_LEN_PER_ITEM),
        received: m.receivedAt ?? undefined,
      }));
    outlook.push(...sortedOutlook);
  }

  if (opts.gdocs && opts.gdocs.length > 0) {
    const sortedGdocs = [...opts.gdocs]
      .sort(byDescModified)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((d) => ({
        name: truncate(d.name ?? '', 160),
        modified: d.modifiedTime ?? undefined,
        owners: Array.isArray(d.owners) ? d.owners.slice(0, 6) : [],
        lastModifyingUser: d.lastModifyingUser ?? undefined,
      }));
    gdocs.push(...sortedGdocs);
  }
  if (opts.gsheets && opts.gsheets.length > 0) {
    const sortedGsheets = [...opts.gsheets]
      .sort(byDescModified)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((s) => ({
        name: truncate(s.name ?? '', 160),
        modified: s.modifiedTime ?? undefined,
        owners: Array.isArray(s.owners) ? s.owners.slice(0, 6) : [],
        lastModifyingUser: s.lastModifyingUser ?? undefined,
      }));
    gsheets.push(...sortedGsheets);
  }
  if (opts.stripe && opts.stripe.length > 0) {
    const sortedStripe = [...opts.stripe]
      .sort(byDescCreatedAtRemote)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((inv) => ({
        number: inv.number ?? undefined,
        status: inv.status ?? undefined,
        amountDue: typeof inv.amountDue === 'number' ? inv.amountDue : undefined,
        currency: inv.currency ?? undefined,
        customer: inv.customerName ?? inv.customerEmail ?? inv.customerId ?? undefined,
        created: inv.createdAtRemote ?? undefined,
      }));
    stripe.push(...sortedStripe);
  }
  if (opts.discord && opts.discord.length > 0) {
    // Discord guilds aren't time-ordered; sort by member count desc as a
    // weak "importance" proxy.
    const sortedDiscord = [...opts.discord]
      .sort((a, b) => (b.approximateMemberCount ?? 0) - (a.approximateMemberCount ?? 0))
      .slice(0, MAX_PROMPT_ITEMS)
      .map((g) => ({
        name: g.name ?? undefined,
        isOwner: Boolean(g.isOwner),
        memberCount: g.approximateMemberCount ?? undefined,
        features: Array.isArray(g.features) ? g.features.slice(0, 5) : [],
      }));
    discord.push(...sortedDiscord);
  }
  if (opts.spotifyRecent && opts.spotifyRecent.length > 0) {
    const sortedSpotify = [...opts.spotifyRecent]
      .sort(byDescPlayedAt)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((t) => ({
        track: truncate(t.trackName ?? '', 80),
        artists: Array.isArray(t.artistNames) ? t.artistNames.slice(0, 3) : [],
        album: truncate(t.albumName ?? '', 80),
        context: t.contextType ?? undefined,
        playedAt: t.playedAt,
      }));
    spotifyRecent.push(...sortedSpotify);
  }
  if (opts.stravaActivities && opts.stravaActivities.length > 0) {
    const sorted = [...opts.stravaActivities]
      .sort((a, b) => (b.startDate ?? '') < (a.startDate ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((a) => ({
        name: truncate(a.name ?? '', 80),
        type: a.activityType ?? undefined,
        distanceKm: typeof a.distanceMeters === 'number'
          ? Number((a.distanceMeters / 1000).toFixed(2)) : undefined,
        movingMin: typeof a.movingTimeSeconds === 'number'
          ? Math.round(a.movingTimeSeconds / 60) : undefined,
        startDate: a.startDate ?? undefined,
      }));
    stravaActivities.push(...sorted);
  }
  if (opts.todoistTasks && opts.todoistTasks.length > 0) {
    // Sort by priority desc (urgent first), then by content for stability.
    const sorted = [...opts.todoistTasks]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .slice(0, MAX_PROMPT_ITEMS)
      .map((t) => ({
        content: truncate(t.content ?? '', 120),
        description: truncate(t.description ?? '', MAX_TEXT_LEN_PER_ITEM),
        priority: t.priority ?? undefined,
        labels: Array.isArray(t.labels) ? t.labels.slice(0, 5) : [],
        dueAt: t.dueAt ?? undefined,
      }));
    todoistTasks.push(...sorted);
  }
  if (opts.youtubeSubs && opts.youtubeSubs.length > 0) {
    const sorted = [...opts.youtubeSubs]
      .slice(0, MAX_PROMPT_ITEMS)
      .map((s) => ({
        title: truncate(s.channelTitle ?? '', 80),
        description: truncate(s.channelDescription ?? '', MAX_TEXT_LEN_PER_ITEM),
      }));
    youtubeSubs.push(...sorted);
  }
  if (opts.trelloBoards && opts.trelloBoards.length > 0) {
    // starred boards first.
    const sorted = [...opts.trelloBoards]
      .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0))
      .slice(0, MAX_PROMPT_ITEMS)
      .map((b) => ({
        name: truncate(b.name ?? '', 80),
        description: truncate(b.description ?? '', MAX_TEXT_LEN_PER_ITEM),
        starred: Boolean(b.starred),
        closed: Boolean(b.closed),
      }));
    trelloBoards.push(...sorted);
  }
  if (opts.jiraProjects && opts.jiraProjects.length > 0) {
    const sorted = [...opts.jiraProjects]
      .slice(0, MAX_PROMPT_ITEMS)
      .map((p) => ({
        key: p.projectKey ?? undefined,
        name: truncate(p.name ?? '', 80),
        description: truncate(p.description ?? '', MAX_TEXT_LEN_PER_ITEM),
        type: p.projectType ?? undefined,
      }));
    jiraProjects.push(...sorted);
  }
  if (opts.twitterBookmarks && opts.twitterBookmarks.length > 0) {
    const sorted = [...opts.twitterBookmarks]
      .sort((a, b) => (b.createdAtRemote ?? '') < (a.createdAtRemote ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((b) => ({
        author: b.authorUsername ?? undefined,
        text: truncate(b.text ?? '', MAX_TEXT_LEN_PER_ITEM),
        lang: b.lang ?? undefined,
        createdAt: b.createdAtRemote ?? undefined,
      }));
    twitterBookmarks.push(...sorted);
  }
  if (opts.calendlyEvents && opts.calendlyEvents.length > 0) {
    const sorted = [...opts.calendlyEvents]
      .sort((a, b) => (b.startAt ?? '') < (a.startAt ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((e) => ({
        name: truncate(e.name ?? '', 80),
        status: e.status ?? undefined,
        startAt: e.startAt ?? undefined,
        invitees: (e.invitees ?? [])
          .map((inv) => inv?.name ?? inv?.email ?? null)
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 5),
      }));
    calendlyEvents.push(...sorted);
  }
  if (opts.linkedinProfile && opts.linkedinProfile.length > 0) {
    for (const p of opts.linkedinProfile.slice(0, 1)) {
      linkedinProfile.push({
        name: truncate([p.firstName, p.lastName].filter(Boolean).join(' ') || p.localizedName || '', 80),
        headline: truncate(p.headline ?? '', MAX_TEXT_LEN_PER_ITEM),
        vanityName: p.vanityName ?? undefined,
      });
    }
  }
  if (opts.linkedinOrgs && opts.linkedinOrgs.length > 0) {
    for (const o of opts.linkedinOrgs.slice(0, MAX_PROMPT_ITEMS)) {
      linkedinOrgs.push({
        orgName: truncate(o.orgName ?? '', 80),
        role: o.role ?? undefined,
        roleState: o.roleState ?? undefined,
      });
    }
  }
  if (opts.figmaUser && opts.figmaUser.length > 0) {
    for (const u of opts.figmaUser.slice(0, 1)) {
      figmaUser.push({ handle: u.handle ?? undefined, email: u.email ?? undefined });
    }
  }
  if (opts.zoomUser && opts.zoomUser.length > 0) {
    for (const u of opts.zoomUser.slice(0, 1)) {
      const accountType = u.accountType === 1 ? 'Basic' : u.accountType === 2 ? 'Licensed' : u.accountType === 3 ? 'On-prem' : undefined;
      zoomUser.push({
        name: truncate(u.displayName ?? [u.firstName, u.lastName].filter(Boolean).join(' ') ?? '', 80),
        email: u.email ?? undefined,
        accountType,
        department: u.department ?? undefined,
        timezone: u.timezone ?? undefined,
      });
    }
  }
  if (opts.zoomApps && opts.zoomApps.length > 0) {
    for (const a of opts.zoomApps.slice(0, MAX_PROMPT_ITEMS)) {
      zoomApps.push({
        name: truncate(a.name ?? '', 80),
        publisher: a.publisher ?? undefined,
        appType: a.appType ?? undefined,
      });
    }
  }
  if (opts.dropboxAccount && opts.dropboxAccount.length > 0) {
    for (const a of opts.dropboxAccount.slice(0, 1)) {
      dropboxAccount.push({
        email: a.email ?? undefined,
        displayName: a.displayName ?? undefined,
        accountType: a.accountType ?? undefined,
        country: a.country ?? undefined,
      });
    }
  }
  if (opts.dropboxFiles && opts.dropboxFiles.length > 0) {
    const sorted = [...opts.dropboxFiles]
      .sort((a, b) => (b.serverModified ?? '') < (a.serverModified ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((f) => ({
        name: truncate(f.name ?? '', 80),
        tag: f.tag ?? undefined,
        pathDisplay: truncate(f.pathDisplay ?? '', 120),
        sizeBytes: typeof f.sizeBytes === 'number' ? f.sizeBytes : undefined,
      }));
    dropboxFiles.push(...sorted);
  }
  if (opts.asanaWorkspaces && opts.asanaWorkspaces.length > 0) {
    for (const w of opts.asanaWorkspaces.slice(0, MAX_PROMPT_ITEMS)) {
      asanaWorkspaces.push({
        name: truncate(w.name ?? '', 80),
        isOrganization: Boolean(w.isOrganization),
      });
    }
  }
  if (opts.asanaTasks && opts.asanaTasks.length > 0) {
    const sorted = [...opts.asanaTasks]
      .sort((a, b) => (b.modifiedAtRemote ?? '') < (a.modifiedAtRemote ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((t) => ({
        name: truncate(t.name ?? '', 80),
        notes: truncate(t.notes ?? '', MAX_TEXT_LEN_PER_ITEM),
        completed: Boolean(t.completed),
        dueOn: t.dueOn ?? undefined,
      }));
    asanaTasks.push(...sorted);
  }
  if (opts.hubspotContacts && opts.hubspotContacts.length > 0) {
    const sorted = [...opts.hubspotContacts]
      .sort((a, b) => (b.modifiedAtRemote ?? '') < (a.modifiedAtRemote ?? '') ? -1 : 1)
      .slice(0, MAX_PROMPT_ITEMS)
      .map((c) => ({
        name: truncate([c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '', 80),
        email: c.email ?? undefined,
        company: c.company ?? undefined,
        jobtitle: c.jobtitle ?? undefined,
        lifecycleStage: c.lifecycleStage ?? undefined,
      }));
    hubspotContacts.push(...sorted);
  }
  if (opts.clickupUser && opts.clickupUser.length > 0) {
    for (const u of opts.clickupUser.slice(0, 1)) {
      clickupUser.push({ username: u.username ?? undefined, email: u.email ?? undefined });
    }
  }
  if (opts.clickupWorkspaces && opts.clickupWorkspaces.length > 0) {
    for (const w of opts.clickupWorkspaces.slice(0, MAX_PROMPT_ITEMS)) {
      clickupWorkspaces.push({
        name: truncate(w.name ?? '', 80),
        membersCount: typeof w.membersCount === 'number' ? w.membersCount : undefined,
      });
    }
  }

  return {
    totalItems:
      gmail.length + gcal.length + slack.length + notion.length +
      gdrive.length + github.length + outlook.length +
      gdocs.length + gsheets.length + stripe.length + discord.length +
      spotifyRecent.length + stravaActivities.length + todoistTasks.length +
      youtubeSubs.length + trelloBoards.length + jiraProjects.length +
      twitterBookmarks.length + calendlyEvents.length +
      linkedinProfile.length + linkedinOrgs.length + figmaUser.length +
      zoomUser.length + zoomApps.length + dropboxAccount.length + dropboxFiles.length +
      asanaWorkspaces.length + asanaTasks.length + hubspotContacts.length +
      clickupUser.length + clickupWorkspaces.length,
    gmail, gcal, slack, notion, gdrive, github, outlook,
    gdocs, gsheets, stripe, discord, spotifyRecent,
    stravaActivities, todoistTasks, youtubeSubs, trelloBoards,
    jiraProjects, twitterBookmarks, calendlyEvents,
    linkedinProfile, linkedinOrgs, figmaUser, zoomUser, zoomApps,
    dropboxAccount, dropboxFiles, asanaWorkspaces, asanaTasks,
    hubspotContacts, clickupUser, clickupWorkspaces,
  };
}

interface ExistingMemorySnapshot { id: string; subject: string | null; textExcerpt: string }

function buildUserMessage(
  toolkit: string,
  sampled: SampledBundle,
  profile: db.ProfileRow | null,
  existingMemories: ExistingMemorySnapshot[],
  connectedAccountId: string | null,
): string {
  const lines: string[] = [];
  lines.push(`Toolkit: ${toolkit}`);
  if (connectedAccountId) {
    // Surface only the trailing 6 chars: enough for the LLM to disambiguate
    // multiple accounts of the same toolkit without leaking the whole id.
    const shortId = connectedAccountId.slice(-6);
    lines.push(`Account label: …${shortId} (this is ONE account of ${toolkit}; user may have others)`);
  }
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
  if (sampled.github.length > 0) {
    lines.push('', `GitHub items (${sampled.github.length} most recent):`);
    sampled.github.forEach((it, i) => {
      const kindWord = it.isPR ? 'PR' : 'Issue';
      const numLabel = typeof it.number === 'number' ? `#${it.number}` : '';
      lines.push(`${i + 1}. ${kindWord} ${numLabel} (${it.repo ?? 'unknown'}) [${it.state ?? '?'}]`);
      if (it.title) lines.push(`   Title: ${it.title}`);
      if (it.labels && it.labels.length > 0) lines.push(`   Labels: ${it.labels.join(', ')}`);
      if (it.updated) lines.push(`   Updated: ${it.updated}`);
    });
  }
  if (sampled.outlook.length > 0) {
    lines.push('', `Outlook messages (${sampled.outlook.length} most recent):`);
    sampled.outlook.forEach((m, i) => {
      lines.push(`${i + 1}. From: ${m.from ?? '(unknown)'}  Subject: ${m.subject ?? '(none)'}`);
      if (m.preview) lines.push(`   Preview: ${m.preview}`);
      if (m.received) lines.push(`   Received: ${m.received}`);
    });
  }
  if (sampled.gdocs.length > 0) {
    lines.push('', `Google Docs documents (${sampled.gdocs.length} most recent):`);
    sampled.gdocs.forEach((d, i) => {
      lines.push(`${i + 1}. ${d.name ?? '(unnamed)'}`);
      if (d.lastModifyingUser) lines.push(`   Last edited by: ${d.lastModifyingUser}`);
      if (d.modified) lines.push(`   Modified: ${d.modified}`);
    });
  }
  if (sampled.gsheets.length > 0) {
    lines.push('', `Google Sheets spreadsheets (${sampled.gsheets.length} most recent):`);
    sampled.gsheets.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.name ?? '(unnamed)'}`);
      if (s.lastModifyingUser) lines.push(`   Last edited by: ${s.lastModifyingUser}`);
      if (s.modified) lines.push(`   Modified: ${s.modified}`);
    });
  }
  if (sampled.stripe.length > 0) {
    lines.push('', `Stripe invoices (${sampled.stripe.length} most recent):`);
    sampled.stripe.forEach((inv, i) => {
      const amt = typeof inv.amountDue === 'number' && inv.currency
        ? ` ${(inv.amountDue / 100).toFixed(2)} ${inv.currency.toUpperCase()}`
        : '';
      lines.push(`${i + 1}. Invoice ${inv.number ?? '(?)'} · ${inv.customer ?? '(no customer)'}${amt}`);
      if (inv.status) lines.push(`   Status: ${inv.status}`);
      if (inv.created) lines.push(`   Created: ${inv.created}`);
    });
  }
  if (sampled.discord.length > 0) {
    lines.push('', `Discord guilds the user belongs to (${sampled.discord.length} top by member count):`);
    sampled.discord.forEach((g, i) => {
      const role = g.isOwner ? ' [owner]' : '';
      const members = typeof g.memberCount === 'number' ? ` · ${g.memberCount} members` : '';
      lines.push(`${i + 1}. ${g.name ?? '(unnamed)'}${role}${members}`);
      if (g.features && g.features.length > 0) lines.push(`   Features: ${g.features.join(', ')}`);
    });
  }
  if (sampled.spotifyRecent.length > 0) {
    lines.push('', `Spotify recently played tracks (${sampled.spotifyRecent.length} most recent):`);
    sampled.spotifyRecent.forEach((t, i) => {
      const artistList = t.artists && t.artists.length > 0 ? t.artists.join(', ') : '(unknown artist)';
      lines.push(`${i + 1}. ${t.track || '(untitled)'} — ${artistList}`);
      if (t.album) lines.push(`   Album: ${t.album}`);
      if (t.context) lines.push(`   Context: ${t.context}`);
      if (t.playedAt) lines.push(`   Played: ${t.playedAt}`);
    });
  }
  if (sampled.stravaActivities.length > 0) {
    lines.push('', `Strava activities (${sampled.stravaActivities.length} most recent):`);
    sampled.stravaActivities.forEach((a, i) => {
      const typ = a.type ? ` ${a.type}` : '';
      const dist = typeof a.distanceKm === 'number' ? ` · ${a.distanceKm}km` : '';
      const time = typeof a.movingMin === 'number' ? ` · ${a.movingMin}min` : '';
      lines.push(`${i + 1}.${typ} ${a.name ?? '(untitled)'}${dist}${time}`);
      if (a.startDate) lines.push(`   Started: ${a.startDate}`);
    });
  }
  if (sampled.todoistTasks.length > 0) {
    lines.push('', `Todoist tasks (${sampled.todoistTasks.length} top-priority):`);
    sampled.todoistTasks.forEach((t, i) => {
      const prio = t.priority ? ` [p${t.priority}]` : '';
      lines.push(`${i + 1}.${prio} ${t.content ?? '(untitled)'}`);
      if (t.description) lines.push(`   ${t.description}`);
      if (t.labels && t.labels.length > 0) lines.push(`   Labels: ${t.labels.join(', ')}`);
      if (t.dueAt) lines.push(`   Due: ${t.dueAt}`);
    });
  }
  if (sampled.youtubeSubs.length > 0) {
    lines.push('', `YouTube channels the user subscribes to (${sampled.youtubeSubs.length} sample):`);
    sampled.youtubeSubs.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title || '(untitled)'}`);
      if (s.description) lines.push(`   ${s.description}`);
    });
  }
  if (sampled.trelloBoards.length > 0) {
    lines.push('', `Trello boards (${sampled.trelloBoards.length} top — starred first):`);
    sampled.trelloBoards.forEach((b, i) => {
      const flags = [b.starred ? 'starred' : null, b.closed ? 'closed' : null].filter(Boolean).join(', ');
      lines.push(`${i + 1}. ${b.name ?? '(untitled)'}${flags ? ` (${flags})` : ''}`);
      if (b.description) lines.push(`   ${b.description}`);
    });
  }
  if (sampled.jiraProjects.length > 0) {
    lines.push('', `Jira projects (${sampled.jiraProjects.length} recently accessed):`);
    sampled.jiraProjects.forEach((p, i) => {
      lines.push(`${i + 1}. [${p.key ?? '?'}] ${p.name ?? '(unnamed)'}${p.type ? ` · ${p.type}` : ''}`);
      if (p.description) lines.push(`   ${p.description}`);
    });
  }
  if (sampled.twitterBookmarks.length > 0) {
    lines.push('', `Twitter bookmarks (${sampled.twitterBookmarks.length} most recent):`);
    sampled.twitterBookmarks.forEach((b, i) => {
      const author = b.author ? `@${b.author}` : '(unknown)';
      lines.push(`${i + 1}. ${author}: ${b.text ?? ''}`);
      if (b.createdAt) lines.push(`   Posted: ${b.createdAt}`);
    });
  }
  if (sampled.calendlyEvents.length > 0) {
    lines.push('', `Calendly scheduled events (${sampled.calendlyEvents.length} most recent):`);
    sampled.calendlyEvents.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.name ?? '(untitled)'}${e.status ? ` [${e.status}]` : ''}`);
      if (e.startAt) lines.push(`   Start: ${e.startAt}`);
      if (e.invitees && e.invitees.length > 0) lines.push(`   With: ${e.invitees.join(', ')}`);
    });
  }
  if (sampled.linkedinProfile.length > 0) {
    lines.push('', 'LinkedIn profile:');
    sampled.linkedinProfile.forEach((p) => {
      if (p.name) lines.push(`Name: ${p.name}${p.vanityName ? ` (@${p.vanityName})` : ''}`);
      if (p.headline) lines.push(`Headline: ${p.headline}`);
    });
  }
  if (sampled.linkedinOrgs.length > 0) {
    lines.push('', `LinkedIn organizations user has roles at (${sampled.linkedinOrgs.length}):`);
    sampled.linkedinOrgs.forEach((o, i) => {
      const stateNote = o.roleState && o.roleState !== 'APPROVED' ? ` [${o.roleState}]` : '';
      lines.push(`${i + 1}. ${o.role ?? 'role'} at ${o.orgName ?? '?'}${stateNote}`);
    });
  }
  if (sampled.figmaUser.length > 0) {
    lines.push('', 'Figma user:');
    sampled.figmaUser.forEach((u) => {
      if (u.handle) lines.push(`Handle: @${u.handle}`);
      if (u.email) lines.push(`Email: ${u.email}`);
    });
  }
  if (sampled.zoomUser.length > 0) {
    lines.push('', 'Zoom user:');
    sampled.zoomUser.forEach((u) => {
      if (u.name) lines.push(`Name: ${u.name}${u.accountType ? ` · ${u.accountType} plan` : ''}`);
      if (u.email) lines.push(`Email: ${u.email}`);
      if (u.department) lines.push(`Dept: ${u.department}`);
      if (u.timezone) lines.push(`Timezone: ${u.timezone}`);
    });
  }
  if (sampled.zoomApps.length > 0) {
    lines.push('', `Zoom integrations the user has installed (${sampled.zoomApps.length}):`);
    sampled.zoomApps.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.name ?? '(unnamed)'}${a.publisher ? ` by ${a.publisher}` : ''}`);
    });
  }
  if (sampled.dropboxAccount.length > 0) {
    lines.push('', 'Dropbox account:');
    sampled.dropboxAccount.forEach((a) => {
      if (a.displayName) lines.push(`Name: ${a.displayName}${a.accountType ? ` · ${a.accountType} plan` : ''}`);
      if (a.email) lines.push(`Email: ${a.email}`);
      if (a.country) lines.push(`Country: ${a.country}`);
    });
  }
  if (sampled.dropboxFiles.length > 0) {
    lines.push('', `Dropbox root-level entries (${sampled.dropboxFiles.length} most recent):`);
    sampled.dropboxFiles.forEach((f, i) => {
      const tag = f.tag === 'folder' ? '📁' : '📄';
      lines.push(`${i + 1}. ${tag} ${f.name ?? '(unnamed)'}${f.pathDisplay ? ` — ${f.pathDisplay}` : ''}`);
    });
  }
  if (sampled.asanaWorkspaces.length > 0) {
    lines.push('', `Asana workspaces (${sampled.asanaWorkspaces.length}):`);
    sampled.asanaWorkspaces.forEach((w, i) => {
      lines.push(`${i + 1}. ${w.name ?? '(unnamed)'}${w.isOrganization ? ' [organization]' : ''}`);
    });
  }
  if (sampled.asanaTasks.length > 0) {
    lines.push('', `Asana tasks assigned to user (${sampled.asanaTasks.length} most recent):`);
    sampled.asanaTasks.forEach((t, i) => {
      const status = t.completed ? '[done]' : '[open]';
      lines.push(`${i + 1}. ${status} ${t.name ?? '(untitled)'}`);
      if (t.notes) lines.push(`   ${t.notes}`);
      if (t.dueOn) lines.push(`   Due: ${t.dueOn}`);
    });
  }
  if (sampled.hubspotContacts.length > 0) {
    lines.push('', `HubSpot contacts (${sampled.hubspotContacts.length} most recent):`);
    sampled.hubspotContacts.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.name ?? '(unknown)'}${c.company ? ` @ ${c.company}` : ''}${c.jobtitle ? ` — ${c.jobtitle}` : ''}`);
      if (c.email) lines.push(`   ${c.email}`);
      if (c.lifecycleStage) lines.push(`   Stage: ${c.lifecycleStage}`);
    });
  }
  if (sampled.clickupUser.length > 0) {
    lines.push('', 'ClickUp user:');
    sampled.clickupUser.forEach((u) => {
      if (u.username) lines.push(`Username: ${u.username}`);
      if (u.email) lines.push(`Email: ${u.email}`);
    });
  }
  if (sampled.clickupWorkspaces.length > 0) {
    lines.push('', `ClickUp workspaces (${sampled.clickupWorkspaces.length}):`);
    sampled.clickupWorkspaces.forEach((w, i) => {
      const members = typeof w.membersCount === 'number' ? ` · ${w.membersCount} members` : '';
      lines.push(`${i + 1}. ${w.name ?? '(unnamed)'}${members}`);
    });
  }
  lines.push('', '── Current state ──');
  if (profile?.summary) {
    lines.push(`Profile summary: ${truncate(profile.summary, 600)}`);
  }
  if (existingMemories.length > 0) {
    lines.push('', `Existing memories (${existingMemories.length} most recent — use these to dedup; reference by id in "supersedes" if you replace):`);
    existingMemories.forEach((m) => {
      const subj = m.subject ?? '—';
      lines.push(`[${m.id}] (${subj}) ${m.textExcerpt}`);
    });
  }
  lines.push('', 'Extract durable NEW facts and reusable skill candidates now. Skip rephrasings of existing memories.');
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
  supersedes: string | null;
}

interface SanitizedSkillWrite {
  title: string;
  description: string | null;
  triggers: string[];
  body: string;
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
    const supersedes = typeof w.supersedes === 'string' && w.supersedes.trim() ? w.supersedes.trim() : null;
    out.push({
      text: truncate(text, 240),
      subject,
      quality,
      confidence,
      tags,
      supersedes,
    });
  }
  return out;
}

function sanitizeSkillWrites(input: AgentSkillWrite[] | undefined): SanitizedSkillWrite[] {
  if (!Array.isArray(input)) return [];
  const out: SanitizedSkillWrite[] = [];
  for (const w of input) {
    if (!w || typeof w !== 'object') continue;
    const title = typeof w.title === 'string' ? w.title.trim() : '';
    const bodyRaw =
      typeof w.bodyMarkdown === 'string' ? w.bodyMarkdown
        : typeof w.body_md === 'string' ? w.body_md
          : typeof w.body === 'string' ? w.body
            : '';
    const body = bodyRaw.trim();
    if (!title || !body) continue;
    const confidence = parseExplicitScore(w.confidence);
    if (confidence == null) continue;
    if (confidence < MIN_SKILL_CONFIDENCE) continue;
    const description = typeof w.description === 'string' && w.description.trim()
      ? truncate(w.description.trim(), MAX_SKILL_DESCRIPTION_LEN)
      : null;
    out.push({
      title: truncate(title, MAX_SKILL_TITLE_LEN),
      description,
      triggers: sanitizeTags(w.triggers),
      body: truncate(body, MAX_SKILL_BODY_LEN),
    });
    if (out.length >= MAX_SKILL_CANDIDATES) break;
  }
  return out;
}

function makeGeneratedSkillId(toolkit: string): string {
  const safeToolkit = toolkit.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'connector';
  return `connector-${safeToolkit}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseExplicitScore(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
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

async function snapshotRecentMemories(): Promise<ExistingMemorySnapshot[]> {
  // Returns id + subject + 200-char text excerpt for the N most recent active
  // memories. Subject-only dedup misses rephrasings — the agent needs the
  // text body to recognize "tech stack: Foo, Bar" === "User knows Foo and Bar".
  const rows = await db.listMemoryV3({
    status: 'active',
    limit: MAX_RECENT_MEMORY_SNAPSHOTS,
    orderBy: 'created_at',
    orderDirection: 'desc',
  });
  return rows.map((row) => ({
    id: row.id,
    subject: row.subject ?? null,
    textExcerpt: truncate(row.text ?? '', MEMORY_SNAPSHOT_TEXT_LEN).replace(/\s+/g, ' '),
  }));
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

function byDescUpdatedAtRemote(
  a: { updatedAtRemote?: string | null }, b: { updatedAtRemote?: string | null },
): number {
  const av = a.updatedAtRemote ?? '';
  const bv = b.updatedAtRemote ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescCreatedAtRemote(
  a: { createdAtRemote?: string | null }, b: { createdAtRemote?: string | null },
): number {
  const av = a.createdAtRemote ?? '';
  const bv = b.createdAtRemote ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescReceivedAt(
  a: { receivedAt?: string | null }, b: { receivedAt?: string | null },
): number {
  const av = a.receivedAt ?? '';
  const bv = b.receivedAt ?? '';
  return av < bv ? 1 : av > bv ? -1 : 0;
}

function byDescPlayedAt(
  a: { playedAt?: string | null }, b: { playedAt?: string | null },
): number {
  const av = a.playedAt ?? '';
  const bv = b.playedAt ?? '';
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
