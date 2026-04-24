/**
 * Dream-run store — Phase 2d.
 *
 * Pre-Phase-2d this module owned a standalone `dream_runs` table holding
 * full dream payloads (journal_markdown, candidates, profile_delta, …).
 * It also opened its own SQLite handle separate from db.ts.
 *
 * Phase 2d collapses dream_runs into the unified `evolution_runs` ledger
 * (trigger_kind='daily_dream'), with the dream-specific payload living in
 * the `details_json` column. This module is now a thin projection layer:
 * external callers (dreaming/service.ts + routes/dreaming.ts) keep using
 * DreamRunRecord; under the hood we read/write evolution_runs via db.ts.
 *
 * The legacy resetStoreForTests + sweepStaleRunningDreams entry points are
 * kept for back-compat; sweep now scans evolution_runs(trigger_kind='daily_dream').
 */

import * as db from '../db.js';
import type { EvolutionRunRow } from '../db.js';
import type {
  DreamTrigger,
  DreamRunRecord,
  DreamSummary,
  DreamProfileDelta,
  DreamGoalDelta,
} from './types.js';

const DREAM_TRIGGER_KIND = 'daily_dream' as const;

interface DreamDetailsJson {
  trigger?: DreamTrigger;
  source_stats?: Record<string, unknown> | null;
  summary?: DreamSummary | null;
  profile_delta?: DreamProfileDelta | null;
  goal_delta?: DreamGoalDelta | null;
  journal_markdown?: string | null;
  candidates?: Array<Record<string, unknown>> | null;
  applied_at?: string | null;
  goals_applied_at?: string | null;
}

function rowToDreamRecord(row: EvolutionRunRow): DreamRunRecord {
  const details = (row.details ?? {}) as DreamDetailsJson;
  const trigger: DreamTrigger = details.trigger ?? 'auto';
  return {
    id: row.id,
    trigger,
    status: row.status,
    window_start: row.window_start ?? '',
    window_end: row.window_end ?? '',
    started_at: row.started_at,
    completed_at: row.completed_at,
    source_stats: details.source_stats ?? null,
    summary: details.summary ?? null,
    profile_delta: details.profile_delta ?? null,
    goal_delta: details.goal_delta ?? null,
    journal_markdown: details.journal_markdown ?? null,
    candidates: details.candidates ?? null,
    applied_at: details.applied_at ?? null,
    goals_applied_at: details.goals_applied_at ?? null,
    error_message: row.error_message,
    superseded: false, // populated by isSuperseded below
  };
}

async function isSuperseded(runId: string, completedAt: string | null): Promise<boolean> {
  if (!completedAt) return false;
  const recent = await db.listEvolutionRuns({
    triggerKind: DREAM_TRIGGER_KIND,
    status: 'completed',
    limit: 50,
  });
  return recent.some((r) =>
    r.id !== runId && r.completed_at && r.completed_at > completedAt
  );
}

async function fetchAndProject(id: string): Promise<DreamRunRecord | null> {
  const row = await db.getEvolutionRun(id);
  if (!row || row.trigger_kind !== DREAM_TRIGGER_KIND) return null;
  const record = rowToDreamRecord(row);
  record.superseded = await isSuperseded(record.id, record.completed_at);
  return record;
}

async function patchDetails(
  id: string,
  patch: Partial<DreamDetailsJson>,
): Promise<void> {
  const row = await db.getEvolutionRun(id);
  if (!row) throw new Error(`Dream run not found: ${id}`);
  const current = (row.details ?? {}) as DreamDetailsJson;
  await db.setEvolutionRunDetails(id, { ...current, ...patch });
}

// ── Public API (DreamRunRecord-shaped, evolution_runs-backed) ───────────

export async function createRun(input: {
  trigger: DreamTrigger;
  windowStart: string;
  windowEnd: string;
}): Promise<DreamRunRecord> {
  const row = await db.createEvolutionRun({
    triggerKind: DREAM_TRIGGER_KIND,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    contextSummary: `dream run (trigger=${input.trigger})`,
  });
  await db.setEvolutionRunDetails(row.id, { trigger: input.trigger });
  return (await fetchAndProject(row.id))!;
}

export async function completeRun(id: string, input: {
  sourceStats: Record<string, unknown>;
  summary: DreamSummary;
  profileDelta: DreamProfileDelta;
  goalDelta: DreamGoalDelta;
  journalMarkdown: string | null;
  candidates: Array<Record<string, unknown>>;
}): Promise<DreamRunRecord> {
  await patchDetails(id, {
    source_stats: input.sourceStats,
    summary: input.summary,
    profile_delta: input.profileDelta,
    goal_delta: input.goalDelta,
    journal_markdown: input.journalMarkdown,
    candidates: input.candidates,
  });
  await db.completeEvolutionRun(id);
  return (await fetchAndProject(id))!;
}

export async function failRun(id: string, errorMessage: string): Promise<DreamRunRecord> {
  await db.failEvolutionRun(id, errorMessage);
  return (await fetchAndProject(id))!;
}

export async function getRun(id: string): Promise<DreamRunRecord | null> {
  return await fetchAndProject(id);
}

export async function listRuns(limit = 30): Promise<DreamRunRecord[]> {
  const rows = await db.listEvolutionRuns({
    triggerKind: DREAM_TRIGGER_KIND,
    limit,
  });
  // Compute superseded once per page using the same recent set.
  const completed = rows.filter((r) => r.status === 'completed' && r.completed_at).sort((a, b) => {
    const aT = a.completed_at ?? ''; const bT = b.completed_at ?? '';
    return bT.localeCompare(aT);
  });
  const newestCompletedAt = completed[0]?.completed_at ?? null;
  return rows.map((r) => {
    const rec = rowToDreamRecord(r);
    rec.superseded = !!(rec.completed_at && newestCompletedAt && rec.completed_at < newestCompletedAt);
    return rec;
  });
}

export async function getLatestSuccessfulRun(_trigger?: DreamTrigger): Promise<DreamRunRecord | null> {
  const rows = await db.listEvolutionRuns({
    triggerKind: DREAM_TRIGGER_KIND,
    status: 'completed',
    limit: 1,
  });
  return rows[0] ? rowToDreamRecord(rows[0]) : null;
}

export async function markApplied(id: string): Promise<DreamRunRecord> {
  const run = await fetchAndProject(id);
  if (!run) throw new Error(`Dream run ${id} not found`);
  if (run.applied_at) return run;
  await patchDetails(id, { applied_at: new Date().toISOString() });
  return (await fetchAndProject(id))!;
}

export async function markGoalsApplied(id: string): Promise<DreamRunRecord> {
  const run = await fetchAndProject(id);
  if (!run) throw new Error(`Dream run ${id} not found`);
  if (run.goals_applied_at) return run;
  await patchDetails(id, { goals_applied_at: new Date().toISOString() });
  return (await fetchAndProject(id))!;
}

/**
 * Mark dream-flavored evolution_runs rows that have been status='running'
 * for longer than `staleAfterMs` as failed. Carried over from Phase 2a's
 * orphan-placeholder cleanup; now scans evolution_runs(trigger_kind='daily_dream')
 * since dream_runs is gone in Phase 2d.
 *
 * Returns the number of rows transitioned to 'failed'.
 */
export async function sweepStaleRunningDreams(staleAfterMs = 5 * 60_000): Promise<number> {
  const stale = await db.listEvolutionRuns({
    triggerKind: DREAM_TRIGGER_KIND,
    status: 'running',
    limit: 200,
  });
  const cutoffMs = Date.now() - staleAfterMs;
  let swept = 0;
  for (const row of stale) {
    const startedMs = Date.parse(row.started_at);
    if (Number.isNaN(startedMs) || startedMs >= cutoffMs) continue;
    await db.failEvolutionRun(row.id,
      `Marked failed by sweepStaleRunningDreams: row stuck in running for >${staleAfterMs}ms (likely an orphan from a deploy or plugin restart)`,
    );
    swept += 1;
  }
  return swept;
}

/**
 * Test-only: kept for back-compat with prior test harnesses that called
 * resetStoreForTests after swapping OPENCLAW_HOME. Now a no-op since we
 * delegate to db.ts which has its own resetDbForTests handle reset.
 */
export function resetStoreForTests(): void { /* no-op since Phase 2d */ }
