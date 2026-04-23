/**
 * Conversation Crystallize — cross-session chat turn aggregation +
 * background evaluator subagent that decides whether to crystallize the
 * recent window into a profile memory or an active user skill.
 *
 * Scope: both MainChat and card-chat turns feed the counter. Card chats
 * also drive chat-feedback (per-card decisions for the next generation
 * loop) — that pipeline is orthogonal to this one and they do not share
 * data stores.
 *
 * Trigger source: auto-loop 1-minute detect timer (see scheduler/auto-loop.ts)
 * or the debug panel Run-now button.
 * Pipeline: threshold check -> mark turn counter reset -> subagent synthesis ->
 *           persist decision (memory / skill / discard) + observability record.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import * as db from '../db.js';
import { parseAgentJson, detectAgentErrorInMessages } from '../pipeline/agent-runner.js';
import { buildCrystallizePrompt } from './prompt.js';
import {
  CONVERSATION_CRYSTAL_ANALYSIS_TYPE,
  CONVERSATION_CRYSTAL_MEMORY_KIND,
  CRYSTALLIZE_MEMORY_KINDS,
  DEFAULT_CRYSTALLIZE_CONFIG,
  TUNABLE_CRYSTALLIZE_KEYS,
  type CrystallizeConfig,
  type CrystallizeDecision,
  type CrystallizeMemoryKind,
  type CrystallizeRunResult,
  type CrystallizeSynthesis,
  type CrystallizeTurn,
  type TunableCrystallizeConfig,
} from './types.js';

// ── Session key conventions ──
// Tracked chat sessions whose turns feed the cross-session learning counter:
//   agent:main:proactive-ai:chat:<rand>              (legacy POST /chat — MainChat)
//   agent:main:proactive-ai:chat-test:<rand>         (test chat)
//   agent:main:proactive-ai:chat-stream:<rand>       (streaming MainChat)
//   agent:main:proactive-ai:chat:card:<cardId>       (card chat — high-signal)
// Not tracked: chat-feedback / crystallize / dreaming internal subagent sessions.
const CARD_CHAT_PREFIX = 'agent:main:proactive-ai:chat:card:';

/**
 * Session keys whose turns should feed the cross-session learning counter.
 * Both MainChat and Card chat belong here — they are complementary signal
 * sources (main = general profile, card = goal-driven preferences). The
 * chat-feedback / crystallize / dreaming subagent sessions (`chat-feedback:`,
 * `crystallize:`, etc.) are excluded because those are internal analyses.
 */
const TRACKABLE_CHAT_PREFIXES = [
  'agent:main:proactive-ai:chat:',         // matches MainChat + chat:card:*
  'agent:main:proactive-ai:chat-test:',
  'agent:main:proactive-ai:chat-stream:',
];

export function isTrackableChatSessionKey(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false;
  return TRACKABLE_CHAT_PREFIXES.some((prefix) => sessionKey.startsWith(prefix));
}

export type ChatSessionKind = 'main' | 'card' | 'other';

export function classifyChatSessionKind(sessionKey: string | null | undefined): ChatSessionKind {
  if (!sessionKey) return 'other';
  if (sessionKey.startsWith(CARD_CHAT_PREFIX)) return 'card';
  if (isTrackableChatSessionKey(sessionKey)) return 'main';
  return 'other';
}

/**
 * Extract the card id from a card-chat session key (e.g.
 * `agent:main:proactive-ai:chat:card:run_manual_xyz` -> `run_manual_xyz`).
 * Returns null for non-card keys.
 */
export function extractCardIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey || !sessionKey.startsWith(CARD_CHAT_PREFIX)) return null;
  const tail = sessionKey.slice(CARD_CHAT_PREFIX.length);
  return tail || null;
}

// ── Dependencies (for test injection) ──

export interface RunCrystallizeDeps {
  getCrystallizeState?: typeof db.getCrystallizeState;
  markCrystallized?: typeof db.markCrystallized;
  addMemory?: typeof db.addMemory;
  addUserSkill?: typeof db.addUserSkill;
  logFeedback?: typeof db.logFeedback;
  getCrystallizeOverride?: typeof db.getCrystallizeOverride;
  collectTurns?: (api: OpenClawPluginApi, cfg: CrystallizeConfig) => Promise<CrystallizeTurn[]>;
  runEvaluator?: (api: OpenClawPluginApi, turns: CrystallizeTurn[], cfg: CrystallizeConfig) => Promise<CrystallizeSynthesis>;
}

// ── Main entry point ──

/**
 * Module-level mutex shared between auto-loop and force-run.
 * Force-run from the debug panel must not race with the 1-min tick.
 */
let _inFlight: Promise<CrystallizeRunResult> | null = null;

export async function runCrystallize(
  api: OpenClawPluginApi,
  opts?: { configOverride?: Partial<CrystallizeConfig>; force?: boolean },
  deps?: RunCrystallizeDeps,
): Promise<CrystallizeRunResult> {
  if (_inFlight) {
    return { skipped: true, reason: 'busy: another crystallize run in flight' };
  }

  const work = (async (): Promise<CrystallizeRunResult> => {
    const persisted = await safeGetOverride(deps?.getCrystallizeOverride);
    const filteredPersisted = pickTunable(persisted);
    const cfg: CrystallizeConfig = {
      ...DEFAULT_CRYSTALLIZE_CONFIG,
      ...filteredPersisted,
      ...(opts?.configOverride ?? {}),
    };
    const d: Required<Omit<RunCrystallizeDeps, 'getCrystallizeOverride'>> = {
      getCrystallizeState: deps?.getCrystallizeState ?? db.getCrystallizeState,
      markCrystallized: deps?.markCrystallized ?? db.markCrystallized,
      addMemory: deps?.addMemory ?? db.addMemory,
      addUserSkill: deps?.addUserSkill ?? db.addUserSkill,
      logFeedback: deps?.logFeedback ?? db.logFeedback,
      collectTurns: deps?.collectTurns ?? collectRecentChatTurns,
      runEvaluator: deps?.runEvaluator ?? runCrystallizeSubagent,
    };

    return runCrystallizeWithEvolutionRun(api, opts ?? {}, cfg, d);
  })();

  _inFlight = work;
  try {
    return await work;
  } finally {
    _inFlight = null;
  }
}

/**
 * Wraps runCrystallizeInner with v3 evolution_runs lifecycle so the
 * `pin evolution recent --kind chat_burst` query reflects every
 * crystallize attempt (skipped or completed). See docs/memory-architecture.md
 * §三 (evolution_runs).
 */
async function runCrystallizeWithEvolutionRun(
  api: OpenClawPluginApi,
  opts: { configOverride?: Partial<CrystallizeConfig>; force?: boolean },
  cfg: CrystallizeConfig,
  d: Required<Omit<RunCrystallizeDeps, 'getCrystallizeOverride'>>,
): Promise<CrystallizeRunResult> {
  const startedAtMs = Date.now();
  let evolutionRunId: string | null = null;
  try {
    const evolutionRun = await db.createEvolutionRun({
      triggerKind: 'chat_burst',
      contextSummary: opts.force ? 'forced via debug panel' : 'auto-loop tick',
    });
    evolutionRunId = evolutionRun.id;
  } catch (err) {
    // evolution_runs is observability — never block crystallize on it.
    api.logger.warn(`[crystallize] failed to open evolution_run: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const result = await runCrystallizeInner(api, opts, cfg, d);
    if (evolutionRunId) {
      try {
        // Only the actual sediment counts as a memory_written / skill_added.
        const memoriesWritten = !result.skipped && result.memoryId ? 1 : 0;
        const skillsAdded = !result.skipped && result.skillId ? 1 : 0;
        await db.recordEvolutionDelta(evolutionRunId, { memoriesWritten, skillsAdded });
        if (result.memoryId) {
          await db.recordEvolutionRefsProduced(evolutionRunId, 'memory', [result.memoryId]);
        }
        if (result.skillId) {
          await db.recordEvolutionRefsProduced(evolutionRunId, 'skill_index', [result.skillId]);
        }
        await db.completeEvolutionRun(evolutionRunId, {
          durationMs: Date.now() - startedAtMs,
        });
      } catch (err) {
        api.logger.warn(`[crystallize] failed to close evolution_run ${evolutionRunId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return result;
  } catch (err) {
    if (evolutionRunId) {
      try {
        await db.failEvolutionRun(evolutionRunId, err instanceof Error ? err.message : String(err));
      } catch { /* observability is best-effort */ }
    }
    throw err;
  }
}

async function safeGetOverride(
  loader?: typeof db.getCrystallizeOverride,
): Promise<Record<string, number>> {
  const fn = loader ?? db.getCrystallizeOverride;
  try {
    return await fn();
  } catch {
    return {};
  }
}

function pickTunable(raw: Record<string, number>): TunableCrystallizeConfig {
  const out: TunableCrystallizeConfig = {};
  for (const key of TUNABLE_CRYSTALLIZE_KEYS) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) {
      (out as Record<string, number>)[key] = raw[key];
    }
  }
  return out;
}

async function runCrystallizeInner(
  api: OpenClawPluginApi,
  opts: { configOverride?: Partial<CrystallizeConfig>; force?: boolean },
  cfg: CrystallizeConfig,
  d: Required<Omit<RunCrystallizeDeps, 'getCrystallizeOverride'>>,
): Promise<CrystallizeRunResult> {
  const state = await d.getCrystallizeState();

  if (!opts?.force) {
    if (state.turn_count < cfg.messageThreshold) {
      return { skipped: true, reason: `below threshold (${state.turn_count}/${cfg.messageThreshold})` };
    }
    if (state.last_crystallized_at) {
      const last = Date.parse(state.last_crystallized_at);
      if (Number.isFinite(last) && Date.now() - last < cfg.cooldownMs) {
        return { skipped: true, reason: 'cooldown active' };
      }
    }
  }

  // Reset counter BEFORE running subagent to avoid duplicate triggers if
  // the evaluator takes longer than one detect-tick.
  await d.markCrystallized();

  let turns: CrystallizeTurn[];
  try {
    turns = await d.collectTurns(api, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn(`[crystallize] collect-turns failed: ${msg}`);
    return { skipped: true, reason: `collect-turns failed: ${msg}` };
  }

  if (turns.length === 0) {
    return { skipped: true, reason: 'no chat turns collected' };
  }

  const totalUserChars = turns.reduce((sum, t) => sum + t.userText.length, 0);
  if (totalUserChars < cfg.minUserChars) {
    api.logger.info(`[crystallize] skipped: user text too short (${totalUserChars}/${cfg.minUserChars})`);
    return { skipped: true, reason: 'below minUserChars' };
  }

  let synthesis: CrystallizeSynthesis;
  try {
    synthesis = await d.runEvaluator(api, turns, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn(`[crystallize] evaluator failed: ${msg}`);
    await d.logFeedback({
      kind: 'text_feedback',
      source: 'agent_analysis',
      channel: 'web',
      text: msg,
      metadata: {
        analysisType: CONVERSATION_CRYSTAL_ANALYSIS_TYPE,
        decision: 'discard',
        reason: `evaluator error: ${msg}`,
        turnCount: turns.length,
      },
    });
    return { skipped: true, reason: `evaluator error: ${msg}` };
  }

  const normalized = normalizeSynthesis(synthesis, cfg);
  const summary = normalized.summary ?? '';
  const salience = normalized.salience;

  let memoryId: string | undefined;
  let skillId: string | undefined;
  let finalDecision: CrystallizeDecision = normalized.decision;

  if (finalDecision === 'memorize' && normalized.memory) {
    try {
      const row = await d.addMemory({
        kind: normalized.memory.kind || CONVERSATION_CRYSTAL_MEMORY_KIND,
        text: normalized.memory.text,
        tags: normalized.memory.tags,
      });
      memoryId = row.id;
    } catch (err) {
      api.logger.warn(`[crystallize] addMemory failed: ${err instanceof Error ? err.message : err}`);
      finalDecision = 'discard';
    }
  } else if (finalDecision === 'create_skill' && normalized.skill) {
    try {
      const skill = await d.addUserSkill({
        source: 'crystallize',
        status: 'active',
        title: normalized.skill.title,
        body_md: normalized.skill.bodyMarkdown,
        triggers: normalized.skill.triggers,
        source_summary: summary || null,
      });
      skillId = skill.id;
      // Also sediment a pointer memory so the skill's origin is searchable.
      try {
        const pointer = await d.addMemory({
          kind: CONVERSATION_CRYSTAL_MEMORY_KIND,
          text: `Skill created from conversation: ${normalized.skill.title}\n\n${summary}`,
          tags: ['skill', 'auto-generated'],
        });
        memoryId = pointer.id;
      } catch { /* pointer memory is best-effort */ }
    } catch (err) {
      api.logger.warn(`[crystallize] addUserSkill failed: ${err instanceof Error ? err.message : err}`);
      finalDecision = 'discard';
    }
  }

  await d.logFeedback({
    kind: 'text_feedback',
    source: 'agent_analysis',
    channel: 'web',
    text: summary,
    metadata: {
      analysisType: CONVERSATION_CRYSTAL_ANALYSIS_TYPE,
      decision: finalDecision,
      salience,
      topics: normalized.topics,
      reason: normalized.reason,
      turnCount: turns.length,
      userChars: totalUserChars,
      memoryId,
      skillId,
    },
  });

  api.logger.info(
    `[crystallize] done decision=${finalDecision} salience=${salience.toFixed(2)} ` +
    `turns=${turns.length} memoryId=${memoryId ?? '-'} skillId=${skillId ?? '-'}`,
  );

  return {
    skipped: false,
    decision: finalDecision,
    summary,
    salience,
    memoryId,
    skillId,
  };
}

// ── Synthesis normalization + salience gate ──

interface NormalizedSynthesis {
  summary?: string;
  salience: number;
  topics: string[];
  decision: CrystallizeDecision;
  reason: string;
  memory?: { kind: CrystallizeMemoryKind; text: string; tags: string[] };
  skill?: { title: string; triggers: string[]; bodyMarkdown: string };
}

/**
 * Coerce the evaluator's `memory.kind` into one of the known enum values.
 * Unknown / missing values fall back to `conversation_crystal` (legacy).
 */
function coerceMemoryKind(raw: unknown): CrystallizeMemoryKind {
  const trimmed = asTrimmedString(raw);
  if (!trimmed) return CONVERSATION_CRYSTAL_MEMORY_KIND as CrystallizeMemoryKind;
  if ((CRYSTALLIZE_MEMORY_KINDS as readonly string[]).includes(trimmed)) {
    return trimmed as CrystallizeMemoryKind;
  }
  return CONVERSATION_CRYSTAL_MEMORY_KIND as CrystallizeMemoryKind;
}

export function normalizeSynthesis(
  raw: CrystallizeSynthesis | null | undefined,
  cfg: CrystallizeConfig,
): NormalizedSynthesis {
  const summary = asTrimmedString(raw?.summary);
  const salience = clampNumber(raw?.salience, 0, 1);
  const topics = asStringArray(raw?.topics).slice(0, 8);
  const reason = asTrimmedString(raw?.reason) ?? '';

  let decision: CrystallizeDecision =
    raw?.decision === 'memorize' || raw?.decision === 'create_skill' || raw?.decision === 'discard'
      ? raw.decision
      : 'discard';

  if (salience < cfg.salienceFloor) {
    decision = 'discard';
  }

  let memory: NormalizedSynthesis['memory'];
  let skill: NormalizedSynthesis['skill'];

  if (decision === 'memorize') {
    const text = truncate(asTrimmedString(raw?.memory?.text) ?? '', cfg.maxMemoryChars);
    if (!text) {
      decision = 'discard';
    } else {
      memory = {
        kind: coerceMemoryKind(raw?.memory?.kind),
        text,
        tags: asStringArray(raw?.memory?.tags).slice(0, 12),
      };
    }
  }

  if (decision === 'create_skill') {
    const title = truncate(asTrimmedString(raw?.skill?.title) ?? '', 120);
    const body = truncate(asTrimmedString(raw?.skill?.bodyMarkdown) ?? '', cfg.maxSkillBodyChars);
    const triggers = asStringArray(raw?.skill?.triggers).slice(0, 8);
    if (!title || !body) {
      decision = 'discard';
    } else {
      skill = { title, triggers, bodyMarkdown: body };
    }
  }

  return {
    summary: summary ?? undefined,
    salience,
    topics,
    decision,
    reason,
    memory,
    skill,
  };
}

// ── Collection: pull recent main-chat turns from subagent session store ──

export async function collectRecentChatTurns(
  api: OpenClawPluginApi,
  cfg: CrystallizeConfig,
): Promise<CrystallizeTurn[]> {
  const state = await db.getCrystallizeState();
  const sessionKey = state.last_session_key;
  if (!sessionKey || !isTrackableChatSessionKey(sessionKey)) return [];

  // For M1 we only sample from the most recent tracked session (main or card).
  // listing sessions across the whole runtime requires API we don't have here,
  // so cross-session aggregation relies on the turn_count counter and falls
  // back to the latest session's tail for transcript content.
  const fetchLimit = Math.max(cfg.messageThreshold * 4, 40);
  let raw: unknown[] = [];
  try {
    const res = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: fetchLimit });
    raw = Array.isArray(res.messages) ? (res.messages as unknown[]) : [];
  } catch {
    return [];
  }

  return pairUserAssistantMessages(raw, sessionKey, cfg);
}

export function pairUserAssistantMessages(
  messages: unknown[],
  sessionKey: string,
  cfg: CrystallizeConfig,
): CrystallizeTurn[] {
  const turns: CrystallizeTurn[] = [];
  const normalized = (messages as Array<{
    role?: string;
    content?: unknown;
    created_at?: string;
    createdAt?: string;
  }>)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: extractText(m.content),
      timestamp: asTrimmedString(m.created_at) ?? asTrimmedString(m.createdAt),
    }))
    .filter((m) => m.content.length > 0);

  for (let i = 0; i < normalized.length; i++) {
    const msg = normalized[i];
    if (msg.role !== 'user') continue;
    // Skip system-injected chat-card opener messages that chat-feedback already handles.
    if (msg.content.startsWith('The user opened ')) continue;
    const next = normalized[i + 1];
    const assistantText = next && next.role === 'assistant' ? next.content : '';
    turns.push({
      sessionKey,
      userText: truncate(msg.content, cfg.maxUserChars),
      assistantText: truncate(assistantText, cfg.maxUserChars),
      timestamp: msg.timestamp ?? null,
    });
  }

  // Keep only the most recent messageThreshold turns and apply a total-size cap.
  const tail = turns.slice(-cfg.messageThreshold);
  let total = 0;
  const trimmed: CrystallizeTurn[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const turn = tail[i];
    const len = turn.userText.length + turn.assistantText.length;
    if (total + len > cfg.maxTotalChars && trimmed.length > 0) break;
    trimmed.unshift(turn);
    total += len;
  }
  return trimmed;
}

// ── Evaluator subagent ──

async function runCrystallizeSubagent(
  api: OpenClawPluginApi,
  turns: CrystallizeTurn[],
  cfg: CrystallizeConfig,
): Promise<CrystallizeSynthesis> {
  if (!api.runtime?.subagent) {
    throw new Error('Conversation crystallize requires runtime subagent');
  }

  const sessionKey = `agent:main:proactive-ai:crystallize:${Date.now().toString(36)}`;
  const systemPrompt = buildCrystallizePrompt(turns);

  const { runId } = await api.runtime.subagent.run({
    sessionKey,
    extraSystemPrompt: systemPrompt,
    idempotencyKey: `proactive-ai:crystallize:${Date.now().toString(36)}`,
    message: 'Distill the transcript into the required JSON. Do not output anything else.',
    deliver: false,
  });

  try {
    const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: cfg.timeoutMs });
    if (result.status !== 'ok') {
      throw new Error(`crystallize subagent failed: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
    }

    const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 10 });
    const messageError = detectAgentErrorInMessages(messages.messages as unknown[]);
    if (messageError) throw new Error(`crystallize subagent failed: ${messageError}`);

    const text = extractLastAssistantText(messages.messages as unknown[]);
    const parsed = parseAgentJson<CrystallizeSynthesis>(text);
    if (!parsed) throw new Error('crystallize subagent returned invalid JSON');
    return parsed;
  } finally {
    api.runtime.subagent.deleteSession({
      sessionKey,
      deleteTranscript: false,
    }).catch(() => {});
  }
}

// ── Helpers ──

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n')
      .trim();
  }
  return '';
}

function extractLastAssistantText(messages: unknown[]): string {
  const list = (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === 'assistant');
  const last = list[list.length - 1];
  return last?.content ? extractText(last.content) : '';
}
