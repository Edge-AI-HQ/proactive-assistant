export const RECOMMENDED_AMBIENT_LLM_MODEL_ID = "gemma-2-2b-q4";
export const RECOMMENDED_AMBIENT_LLM_LABEL = "Gemma 2B";

export function isRecommendedAmbientLlmModel(id: string | null | undefined): boolean {
  return id === RECOMMENDED_AMBIENT_LLM_MODEL_ID;
}
