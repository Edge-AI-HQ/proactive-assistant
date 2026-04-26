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
// Recent-memory snapshot pool given to the agent for dedup. Subject-only
// dedup misses rephrasings (e.g. "tech stack: Foo, Bar" being re-emitted as
// "User knows Foo and Bar"); a 60-row snapshot with id + 200-char excerpt
// lets the agent compare full text and either skip or supersede.
const MAX_RECENT_MEMORY_SNAPSHOTS = 60;
const MEMORY_SNAPSHOT_TEXT_LEN = 200;
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
  | 'slack' | 'notion' | 'googledrive'
  // Phase D round 2
  | 'github' | 'outlook'
  // Phase D round 3
  | 'googledocs' | 'googlesheets' | 'stripe' | 'discord';

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
  github?: raw.GithubIssueInput[];
  outlook?: raw.OutlookMessageInput[];
  gdocs?: raw.GdocsDocumentInput[];
  gsheets?: raw.GsheetsSpreadsheetInput[];
  stripe?: raw.StripeInvoiceInput[];
  discord?: raw.DiscordGuildInput[];
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
  /** Existing memory id this new row replaces. Optional; when set, we mark
   *  the old row status='superseded' after the new row is written. */
  supersedes?: unknown;
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
  const recentMemories = await snapshotRecentMemories().catch(() => []);

  const systemPrompt = buildSystemPrompt(opts.toolkit);
  const userMessage = buildUserMessage(opts.toolkit, sampled, profile, recentMemories);

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

  if (memoryIds.length > 0) {
    await db.recordEvolutionDelta(opts.evolutionRunId, {
      memoriesWritten: memoryIds.length,
      memoriesSuperseded: supersededCount > 0 ? supersededCount : undefined,
    });
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
- No prose outside the json fence. Quote any internal quotes with 「」 or escape with \\".`;
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

  return {
    totalItems:
      gmail.length + gcal.length + slack.length + notion.length +
      gdrive.length + github.length + outlook.length +
      gdocs.length + gsheets.length + stripe.length + discord.length,
    gmail, gcal, slack, notion, gdrive, github, outlook,
    gdocs, gsheets, stripe, discord,
  };
}

interface ExistingMemorySnapshot { id: string; subject: string | null; textExcerpt: string }

function buildUserMessage(
  toolkit: string,
  sampled: SampledBundle,
  profile: db.ProfileRow | null,
  existingMemories: ExistingMemorySnapshot[],
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
  lines.push('', 'Extract durable NEW facts now. Skip rephrasings of existing memories.');
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
