/**
 * RN ambient timeline 模型桥：web NativeAmbientTimelineModelBridge 的对应物。
 * 实现 core 的 AmbientTimelineModelBridge，调 ambient-models Expo 原生模块的
 * 端侧 LLM（generateTimelineEvent / generateTimelineBatchDecision）。
 * payload 构造 + 结果归一 + 错误码全复用 core 的纯助手（双端同源）。
 * 选中模型 id 走 RN AsyncStorage 版 models-selection（异步）。
 */
import {
  modelBatchPayload,
  modelWindowPayload,
  normalizeBatchDecision,
  normalizeDraft,
  normalizeErrorCode,
  normalizeErrorMessage,
  type AmbientCandidateWindow,
  type AmbientTimelineBatchGenerationInput,
  type AmbientTimelineBatchGenerationResult,
  type AmbientTimelineGenerationErrorCode,
  type AmbientTimelineGenerationResult,
  type AmbientTimelineModelBridge,
  type AmbientWindowSummary,
} from "@pin-ai/core";

import { AmbientModels } from "../../../modules/ambient-models";
import { getSelectedAmbientSummaryModelId } from "../models-selection";

export function createAmbientTimelineModelBridge(): AmbientTimelineModelBridge {
  return new RnAmbientTimelineModelBridge();
}

class RnAmbientTimelineModelBridge implements AmbientTimelineModelBridge {
  async summarizeWindow(): Promise<AmbientWindowSummary | null> {
    return null;
  }

  async generateTimelineEvent(
    window: AmbientCandidateWindow,
  ): Promise<AmbientTimelineGenerationResult> {
    const modelId = await getSelectedAmbientSummaryModelId();
    if (!modelId) return { ok: false, errorCode: "no_selected_model" };
    const ready = await selectedModelReadiness(modelId);
    if (!ready.ok) return ready;
    try {
      const value = await AmbientModels.generateTimelineEvent({
        modelId,
        window: modelWindowPayload(window),
      });
      const draft = normalizeDraft(value, window);
      return draft ? { ok: true, draft } : { ok: false, errorCode: "invalid_shape" };
    } catch (err) {
      return { ok: false, errorCode: normalizeErrorCode(err), errorMessage: normalizeErrorMessage(err) };
    }
  }

  async generateTimelineBatchDecision(
    input: AmbientTimelineBatchGenerationInput,
  ): Promise<AmbientTimelineBatchGenerationResult> {
    const modelId = await getSelectedAmbientSummaryModelId();
    if (!modelId) return { ok: false, errorCode: "no_selected_model" };
    const ready = await selectedModelReadiness(modelId);
    if (!ready.ok) return ready;
    try {
      const value = await AmbientModels.generateTimelineBatchDecision({
        modelId,
        batch: modelBatchPayload(input),
      });
      const batch = normalizeBatchDecision(value, input);
      return batch ? { ok: true, batch } : { ok: false, errorCode: "invalid_shape" };
    } catch (err) {
      return { ok: false, errorCode: normalizeErrorCode(err), errorMessage: normalizeErrorMessage(err) };
    }
  }
}

/**
 * 选模型就绪检查（对齐 web selectedModelReadiness）：模型存在 + 是 LLM + 已下载，
 * 未校验则跑一次 verify（runtime 首用自动校验，对齐 web 懒校验语义）。
 */
async function selectedModelReadiness(
  modelId: string,
): Promise<{ ok: true } | { ok: false; errorCode: AmbientTimelineGenerationErrorCode }> {
  let result: Awaited<ReturnType<typeof AmbientModels.listModels>>;
  try {
    result = await AmbientModels.listModels();
  } catch {
    return { ok: false, errorCode: "native_unavailable" };
  }
  const profile = result.profiles.find((item) => item.id === modelId);
  if (!profile) return { ok: false, errorCode: "model_not_found" };
  if (profile.kind !== "llm") return { ok: false, errorCode: "model_not_llm" };
  const status = result.statuses.find((item) => item.id === modelId);
  if (status?.state !== "present") return { ok: false, errorCode: "model_not_present" };
  if (status.lastVerifyResult === "ok") return { ok: true };
  try {
    const verify = await AmbientModels.verifyModel({ id: modelId });
    return verify.ok ? { ok: true } : { ok: false, errorCode: "verify_required" };
  } catch {
    return { ok: false, errorCode: "verify_required" };
  }
}
