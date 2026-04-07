/**
 * @pin-ai/core — shared business logic and data layer.
 *
 * This package is consumed by:
 *   - @pin-ai/cli (Commander.js thin shell, wraps results in PinEnvelope)
 *   - @pin-ai/server (OpenClaw plugin + HTTP API, wraps results in HTTP responses)
 *
 * Core services return plain data and throw CoreError subclasses.
 */

// ── Context ──
export { type CoreContext } from "./context.js";

// ── Errors ──
export {
  CoreError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ProviderUnavailableError,
  InternalError,
  NotImplementedError,
  type CoreErrorType,
} from "./errors.js";

// ── Validation ──
export {
  rejectDangerousChars,
  validateSafePath,
  validateEnum,
  parseSinceToISO,
  parseSinceCutoff,
  parseJsonValue,
  parseJsonObject,
  parseOptionalInt,
  sanitizeForTerminal,
} from "./validation.js";

// ── Database ──
export {
  PinDatabaseManager,
  resolvePinDataRoot,
  type PinDatabaseManagerOptions,
  type PinDatabaseRuntimeState,
  type PinDatabaseName,
} from "./db/database.js";
export { SqliteDatabase } from "./db/sqlite_adapter.js";
export { buildDatabasePaths, type PinDatabasePaths } from "./db/paths.js";

// ── Domain: Profile ──
export * as profile from "./domains/profile/service.js";
export { ProfileRepository } from "./domains/profile/repository.js";
export { profiles, type ProfileRecord, type NewProfileRecord } from "./domains/profile/schema.js";

// ── Domain: World ──
export * as world from "./domains/world/service.js";
export { WorldRepository } from "./domains/world/repository.js";
export { worldItems, type WorldItemRecord, type NewWorldItemRecord } from "./domains/world/schema.js";

// ── Domain: Feedback ──
export * as feedback from "./domains/feedback/service.js";
export { FeedbackRepository } from "./domains/feedback/repository.js";
export { feedbackEvents, type FeedbackEventRecord, type NewFeedbackEventRecord } from "./domains/feedback/schema.js";

// ── Domain: Push ──
export * as push from "./domains/push/service.js";
export { PushRepository } from "./domains/push/repository.js";
export {
  pushRecords, pushOutcomes,
  type PushRecordRow, type NewPushRecordRow,
  type PushOutcomeRow, type NewPushOutcomeRow,
  VALID_PUSH_KINDS, VALID_PUSH_CHANNELS, VALID_BASKETS, VALID_OUTCOME_STATUSES,
} from "./domains/push/schema.js";

// ── Domain: Personal ──
export * as personal from "./domains/personal/service.js";
export {
  type PersonalProvider,
  type PersonalConnection,
  type PersonalToolInfo,
  type PersonalToolSchema,
  type PersonalExecResult,
  createPersonalProvider,
} from "./domains/personal/provider.js";
export { loadPlatformSettings, type PersonalPlatformSettings } from "./domains/personal/platform_settings.js";

// ── Types ──
export {
  type IntentCard,
  type IntentCardAction,
  type GoalBasket,
  GOAL_BASKETS,
  type PlannerOutput,
  type IntentPlan,
  type GeneratorOutput,
  type EvaluationScore,
  type EvaluatorOutput,
  type PipelineIteration,
  type PipelineResult,
  type ServerEvent,
} from "./types/intent-card.js";
export { type WritePreview } from "./types/preview.js";
