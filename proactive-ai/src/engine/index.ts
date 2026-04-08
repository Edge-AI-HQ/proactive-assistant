/**
 * @pin-ai/engine — server + pipeline + agents.
 *
 * Combines:
 *   - agents/     — LLM prompt builders (planner, generator, evaluator, chat)
 *   - pipeline/   — orchestration loop, data access, run storage
 *   - server/     — HTTP handlers, API router, plugin registration
 */

// ── Pipeline ──
export { runPipeline, type PipelineOptions } from './pipeline/orchestrator.js';
export { saveRun, loadRunStore, type StoredRun } from './pipeline/run-store.js';
export { ensureDefaultProfile } from './pipeline/profile-seed.js';

// ── Server ──
export { createApiHandler } from './server/api-router.js';
export { createUiHandler } from './server/ui-route.js';
export { createAssetsHandler } from './server/assets-route.js';

// ── State & Config ──
export { shared, pipelineState, type PipelineState } from './state.js';
export { DEFAULT_CONFIG, type ProactiveAIConfig } from './config.js';

// ── Generation Language ──
export {
  GENERATION_LANGUAGE_OPTIONS,
  DEFAULT_GENERATION_LANGUAGE,
  isSupportedGenerationLanguage,
  getGenerationLanguageLabel,
  type SupportedGenerationLanguage,
} from './generation-language.js';
