/**
 * Ambient 端侧 LLM 推荐位 —— dev `services/ambient/models-recommendation.ts` 逐字镜像
 * （onboarding 模型步 / 未来推荐位共用）。
 */
export const RECOMMENDED_AMBIENT_LLM_MODEL_ID = "gemma-2-2b-q4";
export const RECOMMENDED_AMBIENT_LLM_LABEL = "Gemma 2B";

export function isRecommendedAmbientLlmModel(id: string | null | undefined): boolean {
  return id === RECOMMENDED_AMBIENT_LLM_MODEL_ID;
}
