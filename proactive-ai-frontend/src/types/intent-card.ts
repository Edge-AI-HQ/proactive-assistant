/**
 * Phase 1 shim —— Intent Card 域类型已迁入 @pin-ai/core 的 domain/intent-card
 * （后端类型的唯一前端镜像，三端共用）。旧 import 路径零改动；组件 import
 * 逐步改到 @pin-ai/core 后删除本文件（分层 Phase 4）。
 */
export {
  GENERATION_LANGUAGE_OPTIONS,
  normalizeIntentCard,
  normalizeIntentCards,
  type EvaluationScore,
  type GoalBasket,
  type IntentCard,
  type IntentCardAction,
  type SupportedGenerationLanguage,
} from "@pin-ai/core";
