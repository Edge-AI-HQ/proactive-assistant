/**
 * Main dreaming orchestrator for the cloud proactive-ai plugin.
 * Adapted from standalone service.ts — uses Supabase instead of SQLite,
 * no filesystem artifacts.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import {
  type DreamTrigger,
  type DreamRunRecord,
  type DreamSummary,
  type DreamProfileDelta,
  type DreamGoalDelta,
  type DreamGoalDeltaChange,
  type DreamSourceResult,
  emptyProfileDelta,
  emptyGoalDelta,
} from './types.js';
import * as store from './store.js';
import { collectSignals, collectFeedback, collectCards, collectPersonal } from './sources.js';
import { runAgent, parseAgentJson } from '../pipeline/agent-runner.js';
import { normalizeGenerationLanguage } from '../agents/generation-language.js';
import * as db from '../db.js';

// ── Types ──

export type DreamSourceStatus = 'ok' | 'skipped' | 'error';

export interface DreamRunDetail {
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  summary: DreamSummary;
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
}

interface DreamSourceDefinition {
  id: string;
  collect(input: { windowStart: string; windowEnd: string }): Promise<DreamSourceResult>;
}

interface DreamSynthesis {
  summary?: {
    kind?: DreamSummary['kind'];
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
  trigger: DreamTrigger;
  startedAt: string;
  windowStart: string;
  windowEnd: string;
  currentProfile: Record<string, unknown>;
  sourceStats: Record<string, Record<string, unknown>>;
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  mode: 'primary' | 'deep_retry' | 'json_retry';
}

interface RunDreamingInput {
  api: OpenClawPluginApi;
  trigger: DreamTrigger;
  now?: Date;
  sources?: DreamSourceDefinition[];
}

// ── Constants ──

const DREAM_SUMMARIZER_TIMEOUT_MS = 180_000;

// ── Helpers ──

function compactText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > 0 ? compacted : null;
}

function isChineseLocale(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh');
}

function clampWindowStart(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

function inferItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.itemCount === 'number' && Number.isFinite(record.itemCount)) return record.itemCount;
  if (Array.isArray(record.messages)) return record.messages.length;
  if (Array.isArray(record.events)) return record.events.length;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.results)) return record.results.length;
  let count = 0;
  for (const entry of Object.values(record)) {
    if (Array.isArray(entry)) count += entry.length;
  }
  return count;
}

function buildSourceBreakdown(
  sourceId: string,
  result: DreamSourceResult,
): DreamRunDetail['sourceBreakdown'][number] {
  const breakdown: DreamRunDetail['sourceBreakdown'][number] = {
    sourceId,
    status: result.status,
    itemCount: result.count,
    ...(result.message ? { reason: result.message } : {}),
  };

  if (sourceId !== 'personal') return breakdown;

  const connectors = (result.raw as { connectors?: Record<string, unknown> } | null)?.connectors;
  if (!connectors || typeof connectors !== 'object') return breakdown;

  return {
    ...breakdown,
    connectors: Object.entries(connectors).map(([connectorId, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'status' in value) {
        const record = value as { status?: DreamSourceStatus; reason?: string };
        return {
          connectorId,
          status: record.status ?? 'ok',
          itemCount: inferItemCount(value),
          ...(record.reason ? { reason: record.reason } : {}),
        };
      }
      const itemCount = inferItemCount(value);
      return {
        connectorId,
        status: itemCount > 0 ? 'ok' : 'skipped',
        itemCount,
        ...(itemCount > 0 ? {} : { reason: 'No new connector data' }),
      };
    }),
  };
}

function createInterestRecords(topics: string[], fallbackTimestamp: string): Array<Record<string, unknown>> {
  return topics
    .map((t) => compactText(t)?.toLowerCase())
    .filter((t): t is string => !!t)
    .filter((t, i, list) => list.indexOf(t) === i)
    .slice(0, 5)
    .map((key, index) => ({
      id: `dream_interest_${index}_${key}`,
      kind: 'topic', key, score: 0.8, confidence: 0.8,
      evidenceCount: 1, lastSignalAt: fallbackTimestamp, status: 'active',
    }));
}

function sanitizeGoalKey(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : `dream-goal-${Date.now().toString(36)}`;
}

function normalizeGoalPatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const title = compactText(record.title); if (title) patch.title = title;
  const priority = compactText(record.priority); if (priority) patch.priority = priority;
  const summary = compactText(record.summary); if (summary) patch.summary = summary;
  const status = compactText(record.status); if (status) patch.status = status;
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeGoalDelta(goalDelta: unknown): DreamGoalDelta {
  if (!goalDelta || typeof goalDelta !== 'object' || Array.isArray(goalDelta)) return emptyGoalDelta();
  const changes = Array.isArray((goalDelta as { changes?: unknown[] }).changes)
    ? (goalDelta as { changes: unknown[] }).changes : [];
  const normalized = changes
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const action = compactText(item.action);
      if (action !== 'create' && action !== 'update' && action !== 'close') return null;
      const before = item.before && typeof item.before === 'object' && !Array.isArray(item.before)
        ? item.before as Record<string, unknown> : null;
      const after = normalizeGoalPatch(item.after);
      const rawKey = compactText(item.key) ?? compactText(after?.title) ?? compactText(before?.key);
      if (!rawKey) return null;
      return {
        action, key: sanitizeGoalKey(rawKey),
        reason: compactText(item.reason) ?? 'Dreaming suggested this goal change.',
        before, after: action === 'close' ? null : (after ?? null),
      } satisfies DreamGoalDeltaChange;
    })
    .filter((item): item is DreamGoalDeltaChange => item !== null);
  return { changes: normalized };
}

function sanitizeDreamCandidates(candidates: unknown, fallbackTimestamp: string): Array<Record<string, unknown>> {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, 3)
    .map((item, index) => ({
      id: `dream_candidate_${index + 1}`,
      title: compactText(item.title) ?? `Dream follow-up ${index + 1}`,
      basket: compactText(item.basket) ?? 'life',
      reason: compactText(item.reason) ?? 'Dreaming identified this as worth following up.',
      connector: compactText(item.connector) ?? 'dreaming',
      source: 'dreaming',
      createdAt: fallbackTimestamp,
    }));
}

function normalizeDreamSummaryFromModel(synthesis: DreamSynthesis, fallback: DreamSummary): DreamSummary {
  const kind = synthesis.summary?.kind === 'no_new_data' ? 'no_new_data'
    : synthesis.summary?.kind === 'updated' ? 'updated' : fallback.kind;
  const text = compactText(synthesis.summary?.text) ?? fallback.text;
  const highlights = Array.isArray(synthesis.highlights)
    ? synthesis.highlights.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).slice(0, 5)
    : Array.isArray(synthesis.summary?.highlights)
      ? synthesis.summary!.highlights!.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).slice(0, 5)
      : fallback.highlights ?? [];
  return { kind, text, sourceCount: fallback.sourceCount, candidateCount: fallback.candidateCount, highlights };
}

function buildMinimalSummary(
  sourceStats: Record<string, Record<string, unknown>>,
  locale?: unknown,
): DreamSummary {
  const totalCount = Object.values(sourceStats).reduce((sum, stat) => sum + Number(stat.count ?? 0), 0);
  const activeSourceEntries = Object.entries(sourceStats)
    .filter(([, stat]) => stat.status === 'ok' && Number(stat.count ?? 0) > 0);
  const activeSources = activeSourceEntries.length;
  const isZh = isChineseLocale(locale);

  if (totalCount === 0) {
    return {
      kind: 'no_new_data',
      text: isZh ? '这次 dreaming 在最近的时间窗口里没有发现新的有效数据。' : 'Dreaming found no new data in the latest window.',
      sourceCount: activeSources, candidateCount: 0, highlights: [],
    };
  }

  const sourceList = activeSourceEntries.map(([id]) => id).join(', ');
  return {
    kind: 'updated',
    text: isZh
      ? `本次 Dreaming 采集了 ${totalCount} 条近期内容，来自 ${activeSources} 个活跃来源${sourceList ? `（${sourceList}）` : ''}。等待子代理进一步总结这些上下文。`
      : `Dreaming collected ${totalCount} recent items across ${activeSources} active sources${sourceList ? ` (${sourceList})` : ''}. Waiting for subagent synthesis.`,
    sourceCount: activeSources, candidateCount: 0, highlights: [],
  };
}

function buildProfileDelta(
  currentProfile: Record<string, unknown>,
  sourceStats: Record<string, Record<string, unknown>>,
  summary: DreamSummary,
  candidates: Array<Record<string, unknown>>,
  _normalizedInputs: Record<string, unknown>,
  nowIso: string,
  windowStart: string,
  windowEnd: string,
  options?: { highlights?: string[]; interestTopics?: string[] },
): DreamProfileDelta {
  const currentFacts = (currentProfile.facts ?? {}) as Record<string, unknown>;
  const currentPreferences = (currentProfile.preferences ?? {}) as Record<string, unknown>;
  const currentInterests = (currentProfile.interests ?? []) as Array<Record<string, unknown>>;
  const currentSnapshots = (currentProfile.snapshots ?? []) as Array<Record<string, unknown>>;
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
      latestCandidates: candidates.map((c) => ({ title: c.title, basket: c.basket })),
      sourceStats,
    },
  };

  const preferencesAfter = { ...currentPreferences, dreaming: { lastUpdatedAt: nowIso } };

  const derivedInterests = options?.interestTopics?.length
    ? createInterestRecords(options.interestTopics, nowIso) : [];
  const interestsAfter = derivedInterests.length > 0 ? derivedInterests : currentInterests;

  const snapshotsAfter = [
    ...currentSnapshots,
    {
      view: 'dreaming', generatedAt: nowIso,
      summary: summary.text, kind: summary.kind,
      candidateCount: candidates.length, highlights,
      candidateTitles: candidates.map((c) => c.title),
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

// ── Prompt trimming ──

function trimPromptContextValue(
  value: unknown,
  limits: { maxArrayItems: number; maxObjectEntries: number; maxStringLength: number; maxDepth: number },
  depth = 0,
): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > limits.maxStringLength ? `${value.slice(0, limits.maxStringLength)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) {
    if (Array.isArray(value)) return value.slice(0, 3).map((item) => compactText(item) ?? String(item));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 8)
        .map(([key, child]) => [key, compactText(child) ?? (typeof child === 'object' ? '[object]' : child)]),
    );
  }
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayItems).map((item) => trimPromptContextValue(item, limits, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).slice(0, limits.maxObjectEntries)
      .map(([key, child]) => [key, trimPromptContextValue(child, limits, depth + 1)]),
  );
}

function trimNormalizedInputsForPrompt(normalizedInputs: Record<string, unknown>): Record<string, unknown> {
  return trimPromptContextValue(normalizedInputs, {
    maxArrayItems: 80, maxObjectEntries: 40, maxStringLength: 1200, maxDepth: 5,
  }) as Record<string, unknown>;
}

function trimRawInputsForPrompt(rawInputs: Record<string, unknown>): Record<string, unknown> {
  return trimPromptContextValue(rawInputs, {
    maxArrayItems: 40, maxObjectEntries: 30, maxStringLength: 800, maxDepth: 4,
  }) as Record<string, unknown>;
}

// ── Dreaming prompt ──

function buildDreamingPrompt(input: {
  locale: unknown;
  trigger: DreamTrigger;
  startedAt: string;
  windowStart: string;
  windowEnd: string;
  currentProfile: Record<string, unknown>;
  sourceStats: Record<string, Record<string, unknown>>;
  rawInputs: Record<string, unknown>;
  normalizedInputs: Record<string, unknown>;
  mode?: 'primary' | 'deep_retry' | 'json_retry';
}): string {
  const language = isChineseLocale(input.locale) ? 'Simplified Chinese' : 'English';
  const deepRetryInstruction = input.mode === 'deep_retry'
    ? `
This is a second-pass deep review because the first pass was too conservative.
There ARE concrete personal items in the window. You must dig deeper like a sharp chief of staff:
- Look again for actionable implications in email bodies, calendar events, titles, timestamps, and cross-source overlap.
- Do not dismiss the window as no_new_data unless every concrete item is clearly trivial.
- If you still conclude no_new_data, explain specifically why each concrete personal thread is not actionable.
` : '';
  const jsonRetryInstruction = input.mode === 'json_retry'
    ? `
Your previous reply was invalid JSON.
Retry now and return STRICT JSON ONLY.
- No prose before the JSON.
- No prose after the JSON.
- No markdown code fence.
- Keep summary.text concise and journalMarkdown short enough to avoid truncation.
- If needed, drop lower-priority details instead of producing malformed output.
` : '';
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
- journalMarkdown should use a warm first-person assistant voice, like "今天我替你留意到..." or "今天我帮\${currentProfile.displayName}记下...".
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

// ── Subagent summarizer ──

async function runDreamingSummarizer(
  api: OpenClawPluginApi,
  input: DreamingSummarizerInput,
): Promise<DreamSynthesis> {
  const runPass = async (mode: DreamingSummarizerInput['mode']): Promise<DreamSynthesis | null> => {
    const prompt = buildDreamingPrompt({ ...input, mode });
    try {
      const text = await runAgent(
        api,
        'dreaming',
        prompt,
        'Review the full dream context and return the required JSON.',
        DREAM_SUMMARIZER_TIMEOUT_MS,
      );
      const parsed = parseAgentJson<DreamSynthesis>(text);
      if (!parsed) {
        if (mode !== 'json_retry') return null;
        throw new Error(`Dreaming summarizer returned invalid JSON: ${text.slice(0, 200)}`);
      }
      return parsed;
    } catch (err) {
      if (mode === 'json_retry') throw err;
      return null;
    }
  };

  const primary = await runPass(input.mode);
  if (primary) return primary;
  const jsonRetry = await runPass('json_retry');
  if (jsonRetry) return jsonRetry;
  throw new Error('Dreaming summarizer returned invalid JSON after retry');
}

// ── Profile resolution ──

async function getCurrentProfile(): Promise<Record<string, unknown>> {
  const profile = await db.getProfile();
  if (!profile) return {};
  return profile as unknown as Record<string, unknown>;
}

async function resolveDreamingLanguage(): Promise<unknown> {
  const settings = await db.getUserSettings();
  if (settings.generation_language && settings.generation_language.trim()) {
    return normalizeGenerationLanguage(settings.generation_language);
  }
  const profile = await db.getProfile();
  return profile?.locale ?? 'en';
}

function hasConcretePersonalContext(normalizedInputs: Record<string, unknown>): boolean {
  const personalEntries = Array.isArray(normalizedInputs.personal)
    ? normalizedInputs.personal as Array<Record<string, unknown>> : [];
  return personalEntries.some((entry) =>
    typeof entry.title === 'string'
    || typeof entry.context === 'string'
    || typeof entry.preview === 'string'
    || typeof entry.body === 'string',
  );
}

// ── Default sources ──

function createDefaultSources(): DreamSourceDefinition[] {
  return [
    {
      id: 'personal',
      async collect({ windowStart, windowEnd }) { return await collectPersonal(windowStart, windowEnd); },
    },
    {
      id: 'signals',
      async collect({ windowStart }) { return await collectSignals(windowStart); },
    },
    {
      id: 'feedback',
      async collect({ windowStart, windowEnd }) { return await collectFeedback(windowStart, windowEnd); },
    },
    {
      id: 'cards',
      async collect({ windowStart }) { return await collectCards(windowStart); },
    },
  ];
}

// ── Main execution ──

/**
 * Run dreaming against a *pre-created* dream_run row. Both startDreaming
 * (fire-and-forget) and runDreaming (sync) share this body so we never
 * create the row twice — the previous shape leaked an orphan placeholder
 * stuck in 'running' whenever startDreaming was used by the route handler.
 */
async function executeDreamingForRun(
  input: RunDreamingInput,
  run: DreamRunRecord,
  now: Date,
): Promise<{ run: DreamRunRecord; detail: DreamRunDetail }> {
  const windowEnd = run.window_end;
  const windowStart = run.window_start;
  const startedAtMs = Date.now();

  // Open a v3 evolution_run for trajectory visibility (`pin evolution recent
  // --kind daily_dream`). Failures are logged but never block dreaming.
  // See docs/memory-architecture.md §三.
  let evolutionRunId: string | null = null;
  try {
    const evolution = await db.createEvolutionRun({
      triggerKind: 'daily_dream',
      windowStart,
      windowEnd,
      contextSummary: `dream run ${run.id} (trigger=${input.trigger})`,
    });
    evolutionRunId = evolution.id;
  } catch {
    // observability best-effort; dreaming continues regardless
  }

  try {
    const currentProfile = await getCurrentProfile();
    const dreamingLanguage = await resolveDreamingLanguage();
    const sources = input.sources ?? createDefaultSources();
    const rawInputs: Record<string, unknown> = {};
    const normalizedInputs: Record<string, unknown> = {};
    const sourceStats: Record<string, Record<string, unknown>> = {};
    const sourceBreakdown: DreamRunDetail['sourceBreakdown'] = [];

    for (const source of sources) {
      try {
        const result = await source.collect({ windowStart, windowEnd });
        rawInputs[source.id] = result.raw;
        normalizedInputs[source.id] = result.normalized;
        sourceStats[source.id] = {
          status: result.status, count: result.count,
          ...(result.message ? { message: result.message } : {}),
        };
        sourceBreakdown.push(buildSourceBreakdown(source.id, result));
      } catch (error) {
        rawInputs[source.id] = [];
        normalizedInputs[source.id] = [];
        sourceStats[source.id] = {
          status: 'error', count: 0,
          message: error instanceof Error ? error.message : String(error),
        };
        sourceBreakdown.push({
          sourceId: source.id, status: 'error', itemCount: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const nowIso = now.toISOString();
    const fallbackSummary = buildMinimalSummary(sourceStats, dreamingLanguage);
    let highlights: string[] = [];
    let candidates: Array<Record<string, unknown>> = [];
    let summary = fallbackSummary;
    let goalDelta = emptyGoalDelta();
    let markdown: string | null = null;
    let interestTopics: string[] | undefined;

    const summarizerInput: DreamingSummarizerInput = {
      locale: dreamingLanguage,
      trigger: input.trigger,
      startedAt: run.started_at,
      windowStart, windowEnd,
      currentProfile,
      sourceStats, rawInputs,
      normalizedInputs: trimNormalizedInputsForPrompt(normalizedInputs),
      mode: 'primary',
    };

    const synthesis = await runDreamingSummarizer(input.api, summarizerInput);
    candidates = sanitizeDreamCandidates(synthesis.candidateCards, nowIso);
    summary = normalizeDreamSummaryFromModel(synthesis, {
      ...buildMinimalSummary(sourceStats, dreamingLanguage),
      candidateCount: candidates.length,
    });
    highlights = Array.isArray(summary.highlights)
      ? summary.highlights.filter((i): i is string => typeof i === 'string') : [];
    markdown = typeof synthesis.journalMarkdown === 'string' && synthesis.journalMarkdown.trim().length > 0
      ? synthesis.journalMarkdown.trim() : null;
    interestTopics = Array.isArray(synthesis.interestTopics)
      ? synthesis.interestTopics.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
      : undefined;
    goalDelta = normalizeGoalDelta(synthesis.goalDelta);

    // Deep retry if no_new_data but has personal context
    if (summary.kind === 'no_new_data' && candidates.length === 0 && hasConcretePersonalContext(normalizedInputs)) {
      const retrySynthesis = await runDreamingSummarizer(input.api, { ...summarizerInput, mode: 'deep_retry' });
      candidates = sanitizeDreamCandidates(retrySynthesis.candidateCards, nowIso);
      summary = normalizeDreamSummaryFromModel(retrySynthesis, {
        ...buildMinimalSummary(sourceStats, dreamingLanguage),
        candidateCount: candidates.length,
      });
      highlights = Array.isArray(summary.highlights)
        ? summary.highlights.filter((i): i is string => typeof i === 'string') : [];
      markdown = typeof retrySynthesis.journalMarkdown === 'string' && retrySynthesis.journalMarkdown.trim().length > 0
        ? retrySynthesis.journalMarkdown.trim() : markdown;
      interestTopics = Array.isArray(retrySynthesis.interestTopics)
        ? retrySynthesis.interestTopics.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
        : interestTopics;
      goalDelta = normalizeGoalDelta(retrySynthesis.goalDelta);
    }

    if (!markdown) {
      throw new Error('Dreaming summarizer returned no journalMarkdown');
    }

    const profileDelta = buildProfileDelta(
      currentProfile, sourceStats, summary, candidates,
      normalizedInputs, nowIso, windowStart, windowEnd,
      { highlights, interestTopics },
    );

    const completedRun = await store.completeRun(run.id, {
      sourceStats, summary, profileDelta, goalDelta,
      journalMarkdown: markdown, candidates,
    });

    // Mirror the dream's outcome into evolution_runs so the v3 trajectory
    // ledger reflects what changed. profile_delta + goal_delta are
    // applied later via apply* helpers (which run async); here we record
    // intent only.
    if (evolutionRunId) {
      try {
        const profileChangedKeys = collectProfileDeltaKeys(profileDelta);
        await db.recordEvolutionDelta(evolutionRunId, {
          profileUpdated: profileChangedKeys.length > 0,
          profileChangedKeys,
        });
        await db.completeEvolutionRun(evolutionRunId, {
          durationMs: Date.now() - startedAtMs,
        });
      } catch { /* observability best-effort */ }
    }

    return {
      run: completedRun,
      detail: {
        rawInputs, normalizedInputs, summary,
        dreamMarkdown: markdown, profileDelta, goalDelta,
        candidates, sourceBreakdown,
      },
    };
  } catch (error) {
    await store.failRun(run.id, error instanceof Error ? error.message : String(error));
    if (evolutionRunId) {
      try {
        await db.failEvolutionRun(evolutionRunId, error instanceof Error ? error.message : String(error));
      } catch { /* observability best-effort */ }
    }
    throw error;
  }
}

/**
 * Extract a flat array of keys touched by the dream's profile delta —
 * for evolution_runs.profile_changed_keys_json.
 */
function collectProfileDeltaKeys(delta: unknown): string[] {
  if (!delta || typeof delta !== 'object') return [];
  const out = new Set<string>();
  const obj = delta as Record<string, unknown>;
  for (const key of ['facts', 'preferences', 'interests', 'summary']) {
    const value = obj[key];
    if (Array.isArray(value) && value.length > 0) out.add(key);
    else if (value && typeof value === 'object' && Object.keys(value as object).length > 0) out.add(key);
    else if (typeof value === 'string' && value.trim().length > 0) out.add(key);
  }
  return Array.from(out);
}

// ── Public API ──

async function createDreamRun(input: RunDreamingInput): Promise<{ run: DreamRunRecord; now: Date }> {
  const now = input.now ?? new Date();
  const windowEnd = now.toISOString();
  const windowStart = clampWindowStart(now);
  const run = await store.createRun({ trigger: input.trigger, windowStart, windowEnd });
  return { run, now };
}

export async function runDreaming(input: RunDreamingInput): Promise<{ run: DreamRunRecord; detail: DreamRunDetail }> {
  const { run, now } = await createDreamRun(input);
  return await executeDreamingForRun(input, run, now);
}

export async function startDreaming(input: RunDreamingInput): Promise<DreamRunRecord> {
  const { run, now } = await createDreamRun(input);
  void executeDreamingForRun(input, run, now).catch(() => {
    // The run state is persisted as failed inside executeDreamingForRun.
  });
  return run;
}

export async function listDreamRuns(): Promise<DreamRunRecord[]> {
  return await store.listRuns(30);
}

export async function getDreamRun(runId: string): Promise<DreamRunRecord | null> {
  return await store.getRun(runId);
}

export async function getDreamRunDetail(runId: string): Promise<{ run: DreamRunRecord; detail: DreamRunDetail } | null> {
  const run = await store.getRun(runId);
  if (!run) return null;

  const fallbackSummary: DreamSummary = run.status === 'running'
    ? { kind: 'running', text: 'Dreaming is collecting inputs and writing logs.', sourceCount: 0, candidateCount: 0 }
    : run.status === 'failed'
      ? { kind: 'failed', text: run.error_message ?? 'Dreaming failed before completion.', sourceCount: 0, candidateCount: 0 }
      : { kind: 'no_new_data', text: 'Dreaming has not produced artifacts yet.', sourceCount: 0, candidateCount: 0 };

  return {
    run,
    detail: {
      rawInputs: {},
      normalizedInputs: {},
      summary: run.summary ?? fallbackSummary,
      dreamMarkdown: run.journal_markdown ?? '',
      profileDelta: run.profile_delta ?? emptyProfileDelta(),
      goalDelta: run.goal_delta ?? emptyGoalDelta(),
      candidates: run.candidates ?? [],
      sourceBreakdown: [],
    },
  };
}

export async function applyDreamProfile(runId: string): Promise<DreamRunRecord> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Dream run ${runId} not found`);
  if (run.applied_at) return run;
  if (run.status !== 'completed') throw new Error(`Dream run ${runId} is not completed`);
  if (!run.profile_delta) throw new Error(`Dream run ${runId} has no profile delta`);

  const delta = run.profile_delta;

  // Apply facts
  for (const [key, value] of Object.entries(delta.facts.after)) {
    await db.setFact(key, value);
  }

  // Apply preferences
  for (const [key, value] of Object.entries(delta.preferences.after)) {
    await db.setPreference(key, value);
  }

  // Apply interests
  for (const interest of delta.interests.after) {
    const kind = compactText(interest.kind);
    const key = compactText(interest.key);
    if (!kind || !key) continue;
    await db.upsertInterest({
      kind, key,
      score: typeof interest.score === 'number' ? interest.score : 0.5,
      confidence: typeof interest.confidence === 'number' ? interest.confidence : 0.5,
      evidenceCount: typeof interest.evidenceCount === 'number' ? interest.evidenceCount : 1,
      lastSignalAt: typeof interest.lastSignalAt === 'string' ? interest.lastSignalAt : undefined,
    });
  }

  return await store.markApplied(runId);
}

export async function applyDreamGoals(runId: string): Promise<DreamRunRecord> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Dream run ${runId} not found`);
  if (run.goals_applied_at) return run;
  if (run.status !== 'completed') throw new Error(`Dream run ${runId} is not completed`);

  const goalDelta = run.goal_delta ?? emptyGoalDelta();
  if (goalDelta.changes.length === 0) {
    return await store.markGoalsApplied(runId);
  }

  for (const change of goalDelta.changes) {
    if (change.action === 'close') {
      await db.closeGoal(change.key);
      continue;
    }
    const after = change.after ?? {};
    const title = compactText(after.title);
    if (!title) throw new Error(`Goal change ${change.key} is missing a title`);
    await db.upsertGoal({
      key: change.key,
      title,
      priority: compactText(after.priority) ?? undefined,
    });
  }

  return await store.markGoalsApplied(runId);
}
