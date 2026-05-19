export interface AmbientSummarySchedulerState {
  lastSummaryAttemptAt: string | null;
  lastSummarySuccessAt: string | null;
  lastNoContentAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export const AMBIENT_SUMMARY_INTERVAL_MS = 15 * 60_000;

export const DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE: AmbientSummarySchedulerState = {
  lastSummaryAttemptAt: null,
  lastSummarySuccessAt: null,
  lastNoContentAt: null,
  retryCount: 0,
  nextRetryAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
};

const RETRY_BACKOFF_MS = [60_000, 3 * 60_000] as const;

export function shouldRunAmbientSummary(
  state: AmbientSummarySchedulerState,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;
  const nextRetryMs = parseIsoMs(state.nextRetryAt);
  if (nextRetryMs !== null && nowMs < nextRetryMs) return false;
  const lastEffectiveMs = latestIsoMs(state.lastSummarySuccessAt, state.lastNoContentAt);
  if (lastEffectiveMs === null) return true;
  return nowMs - lastEffectiveMs >= AMBIENT_SUMMARY_INTERVAL_MS;
}

export function recordAmbientSummarySuccess(
  state: AmbientSummarySchedulerState,
  now: Date,
): AmbientSummarySchedulerState {
  return {
    ...state,
    lastSummaryAttemptAt: now.toISOString(),
    lastSummarySuccessAt: now.toISOString(),
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

export function recordAmbientSummaryNoContent(
  state: AmbientSummarySchedulerState,
  now: Date,
): AmbientSummarySchedulerState {
  return {
    ...state,
    lastSummaryAttemptAt: now.toISOString(),
    lastNoContentAt: now.toISOString(),
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

export function recordAmbientSummaryModelError(
  state: AmbientSummarySchedulerState,
  now: Date,
  errorCode: string,
  errorMessage?: string,
): AmbientSummarySchedulerState {
  return {
    ...state,
    lastSummaryAttemptAt: now.toISOString(),
    lastErrorCode: errorCode,
    lastErrorMessage: errorMessage ?? null,
  };
}

export function recordAmbientSummaryFailure(
  state: AmbientSummarySchedulerState,
  now: Date,
  errorCode: string,
  errorMessage?: string,
): AmbientSummarySchedulerState {
  const retryCount = Math.min(3, state.retryCount + 1);
  const backoff = RETRY_BACKOFF_MS[retryCount - 1] ?? AMBIENT_SUMMARY_INTERVAL_MS;
  return {
    ...state,
    lastSummaryAttemptAt: now.toISOString(),
    retryCount,
    nextRetryAt: new Date(now.getTime() + backoff).toISOString(),
    lastErrorCode: errorCode,
    lastErrorMessage: errorMessage ?? null,
  };
}

function latestIsoMs(...values: Array<string | null>): number | null {
  const parsed = values
    .map(parseIsoMs)
    .filter((value): value is number => value !== null);
  return parsed.length > 0 ? Math.max(...parsed) : null;
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
