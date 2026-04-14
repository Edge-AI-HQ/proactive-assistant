export type DreamTrigger = 'auto' | 'manual';
export type DreamRunStatus = 'running' | 'completed' | 'failed';

export interface DreamSummary {
  kind: string;
  text: string;
  sourceCount: number;
  candidateCount: number;
  highlights?: string[];
  [key: string]: unknown;
}

export interface DreamProfileFieldDelta<T> { before: T; after: T; }

export interface DreamProfileDelta {
  facts: DreamProfileFieldDelta<Record<string, unknown>>;
  preferences: DreamProfileFieldDelta<Record<string, unknown>>;
  interests: DreamProfileFieldDelta<Array<Record<string, unknown>>>;
  snapshots: DreamProfileFieldDelta<Array<Record<string, unknown>>>;
}

export interface DreamGoalDeltaChange {
  action: 'create' | 'update' | 'close';
  key: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface DreamGoalDelta { changes: DreamGoalDeltaChange[]; }

export interface DreamRunRecord {
  id: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  window_start: string;
  window_end: string;
  started_at: string;
  completed_at: string | null;
  source_stats: Record<string, unknown> | null;
  summary: DreamSummary | null;
  profile_delta: DreamProfileDelta | null;
  goal_delta: DreamGoalDelta | null;
  journal_markdown: string | null;
  candidates: Array<Record<string, unknown>> | null;
  applied_at: string | null;
  goals_applied_at: string | null;
  error_message: string | null;
  superseded: boolean;
}

export interface DreamSourceResult {
  status: 'ok' | 'skipped' | 'error';
  count: number;
  raw: unknown;
  normalized: unknown;
  message?: string;
}

export function emptyProfileDelta(): DreamProfileDelta {
  return {
    facts: { before: {}, after: {} },
    preferences: { before: {}, after: {} },
    interests: { before: [], after: [] },
    snapshots: { before: [], after: [] },
  };
}

export function emptyGoalDelta(): DreamGoalDelta { return { changes: [] }; }
