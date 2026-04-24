/**
 * Phase C — daily dreaming enqueuer.
 *
 * Companion to tasks/handlers/auto-dreaming.ts. The handler runs the dream;
 * this module decides WHEN to enqueue one. Mirrors the responsibilities of
 * `runAutoDreaming` in scheduler/auto-loop.ts but persists the decision in
 * background_tasks instead of relying on in-process state.
 *
 * Idempotency:
 *   key = `auto.dreaming:<local_day>`
 *   The local day is computed from the user's profile timezone (falling back
 *   to the system timezone). One task per local day, period — re-runs of
 *   the enqueuer the same day return the existing row, never duplicate.
 *
 * Failure semantics:
 *   - setting off → no-op, returns reason='setting_off'
 *   - not yet 06:00 local → no-op, returns reason='not_due'
 *   - already enqueued today → no-op, returns reason='already_enqueued'
 *   - DB error during enqueue → returned as reason='enqueue_failed'
 *
 * Dependency-injectable for tests: callers can override the time check
 * and the local-day computation.
 */
import * as db from '../db.js';
import {
  isDreamingDue,
  resolveDreamingTimezone,
} from '../dreaming/schedule.js';

export interface DreamingEnqueuerDeps {
  /** Override "now" for tests. Defaults to new Date(). */
  now?: Date;
  /**
   * Override the timezone resolution. When omitted, reads
   * profile.timezone and falls back to the system timezone.
   */
  timezoneOverride?: string;
  /**
   * Test hook: provide the prior auto-completed dream timestamp directly.
   * Production reads it from evolution_runs(trigger_kind='daily_dream',
   * status='completed') ORDER BY started DESC LIMIT 1.
   */
  lastAutoCompletedAtOverride?: string | null;
}

export type DreamingEnqueueReason =
  | 'enqueued'
  | 'already_enqueued'
  | 'setting_off'
  | 'not_due'
  | 'enqueue_failed';

export interface DreamingEnqueueReport {
  reason: DreamingEnqueueReason;
  /** ISO local day key used to build the idempotency key. */
  localDay?: string;
  /** Timezone we computed the local day against. */
  timezone?: string;
  /** Task id when reason='enqueued' or 'already_enqueued'. */
  taskId?: string;
  /** Failure detail when reason='enqueue_failed'. */
  errorMessage?: string;
}

/**
 * Run one enqueuer pass. Idempotent and side-effect free unless the day
 * is genuinely new and dreaming is due — in which case it inserts one
 * `auto.dreaming` row into background_tasks.
 */
export async function maybeEnqueueDailyDreaming(
  deps: DreamingEnqueuerDeps = {},
): Promise<DreamingEnqueueReport> {
  // 1. Setting check — user can disable auto-dreaming entirely
  const userSettings = await db.getUserSettings();
  if (!userSettings.auto_dreaming) {
    return { reason: 'setting_off' };
  }

  // 2. Resolve timezone + compute local day key
  const profile = await db.getProfile();
  const timezone = deps.timezoneOverride ?? resolveDreamingTimezone(
    typeof profile?.timezone === 'string' ? profile.timezone : null,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const now = deps.now ?? new Date();
  const localDay = toLocalDayKey(now, timezone);
  const idempotencyKey = `auto.dreaming:${localDay}`;

  // 3. Cheap pre-check: if today's task already exists, return its id
  // without going through the enqueue machinery (saves a write).
  const existing = await db.getBackgroundTaskByIdempotencyKey(idempotencyKey);
  if (existing) {
    return {
      reason: 'already_enqueued',
      localDay,
      timezone,
      taskId: existing.id,
    };
  }

  // 4. Due check — must be past local 06:00 AND no auto dream completed
  // today already. lastAutoCompletedAt comes from evolution_runs
  // (the unified ledger; legacy dream_runs has been migrated).
  const lastAutoCompletedAt = deps.lastAutoCompletedAtOverride !== undefined
    ? deps.lastAutoCompletedAtOverride
    : await readLastAutoDreamCompletion();

  if (!isDreamingDue({ now, timezone, lastAutoCompletedAt })) {
    return { reason: 'not_due', localDay, timezone };
  }

  // 5. Enqueue with max_attempts=1 — dream is expensive; one shot only.
  // Reconciler-style retry would cost real money on transient failure.
  try {
    const result = await db.enqueueBackgroundTask({
      type: 'auto.dreaming',
      idempotencyKey,
      priority: 30,
      maxAttempts: 1,
      payload: { trigger: 'auto', localDay, timezone },
    });
    return {
      reason: result.created ? 'enqueued' : 'already_enqueued',
      localDay,
      timezone,
      taskId: result.task.id,
    };
  } catch (err) {
    return {
      reason: 'enqueue_failed',
      localDay,
      timezone,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reads the latest completed dream from evolution_runs. Returns null when
 * no dream has ever completed.
 */
async function readLastAutoDreamCompletion(): Promise<string | null> {
  const runs = await db.listEvolutionRuns({
    triggerKind: 'daily_dream',
    status: 'completed',
    limit: 1,
  });
  return runs[0]?.completed_at ?? null;
}

function toLocalDayKey(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
