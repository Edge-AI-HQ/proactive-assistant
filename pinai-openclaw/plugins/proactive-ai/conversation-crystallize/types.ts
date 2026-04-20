/**
 * Types for the conversation crystallize pipeline.
 *
 * A background subagent reads the last N main-chat turns (cross-session),
 * decides whether they are worth persisting, and emits one of three actions:
 *   - memorize: write a durable profile_memories entry
 *   - create_skill: create an active user_skills row
 *   - discard: log only, no persistent side effect
 */

export type CrystallizeDecision = 'memorize' | 'create_skill' | 'discard';

export interface CrystallizeMemoryPayload {
  kind: string;
  text: string;
  tags: string[];
}

export interface CrystallizeSkillPayload {
  title: string;
  triggers: string[];
  bodyMarkdown: string;
}

/** Shape returned by the evaluator subagent (strict JSON). */
export interface CrystallizeSynthesis {
  summary?: string;
  salience?: number;
  topics?: string[];
  decision?: CrystallizeDecision;
  reason?: string;
  memory?: Partial<CrystallizeMemoryPayload>;
  skill?: Partial<CrystallizeSkillPayload>;
}

/** Normalized view of one collected main-chat exchange. */
export interface CrystallizeTurn {
  sessionKey: string;
  userText: string;
  assistantText: string;
  timestamp: string | null;
}

export interface CrystallizeRunResult {
  skipped: boolean;
  reason?: string;
  decision?: CrystallizeDecision;
  summary?: string;
  salience?: number;
  memoryId?: string;
  skillId?: string;
}

/** Overridable thresholds + tuning knobs. */
export interface CrystallizeConfig {
  messageThreshold: number;         // trigger once turn_count >= threshold
  cooldownMs: number;               // min ms between consecutive runs
  minUserChars: number;             // minimum aggregated user characters
  salienceFloor: number;            // force discard below this score
  timeoutMs: number;                // subagent timeout
  maxUserChars: number;             // single-message char cap
  maxTotalChars: number;            // whole transcript cap
  maxSkillBodyChars: number;        // cap on generated skill body markdown
  maxMemoryChars: number;           // cap on generated memory text
}

export const DEFAULT_CRYSTALLIZE_CONFIG: CrystallizeConfig = {
  messageThreshold: 10,
  cooldownMs: 30 * 60 * 1000,
  minUserChars: 200,
  salienceFloor: 0.3,
  timeoutMs: 120_000,
  maxUserChars: 2000,
  maxTotalChars: 8000,
  maxSkillBodyChars: 2048,
  maxMemoryChars: 1500,
};

export const CONVERSATION_CRYSTAL_ANALYSIS_TYPE = 'conversation_crystal';
export const CONVERSATION_CRYSTAL_MEMORY_KIND = 'conversation_crystal';

/**
 * Subset of CrystallizeConfig that is safe to expose to the debug panel.
 * The remaining fields (size caps + timeout) are prompt-safety boundaries
 * and intentionally not user-tunable.
 */
export const TUNABLE_CRYSTALLIZE_KEYS = [
  'messageThreshold',
  'cooldownMs',
  'salienceFloor',
  'minUserChars',
] as const;

export type TunableCrystallizeKey = typeof TUNABLE_CRYSTALLIZE_KEYS[number];

export type TunableCrystallizeConfig = Partial<Pick<CrystallizeConfig, TunableCrystallizeKey>>;

/** Hard bounds enforced by both backend route and frontend input controls. */
export const TUNABLE_BOUNDS: Record<TunableCrystallizeKey, { min: number; max: number; integer: boolean }> = {
  messageThreshold: { min: 1, max: 100, integer: true },
  cooldownMs: { min: 0, max: 24 * 60 * 60 * 1000, integer: true },
  salienceFloor: { min: 0, max: 1, integer: false },
  minUserChars: { min: 0, max: 10_000, integer: true },
};
