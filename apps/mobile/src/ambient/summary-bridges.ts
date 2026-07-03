/**
 * Ambient summary 模型桥（RN）—— dev services/ambient/summary-bridges.ts 的
 * 对应物。cloud-first：先打 POST /api/ambient/summary（core
 * summarizeAmbientWithCloud），失败退回端侧桥。
 *
 * 端侧桥现状：RN 的 ambient-models 原生模块还没有 generateAmbientSummaryEvent
 * 方法（web 的 NativeModelsApi 有），所以 local 桥走 dev 同款「native 不可用」
 * 分支（summary-bridges.ts:9-15），返回 native_unavailable——native 补齐该方法
 * 后再接真实端侧生成。
 */
import {
  summarizeAmbientWithCloud,
  type AmbientSummaryContext,
  type AmbientSummaryModelBridge,
} from "@pin-ai/core";

export function createLocalAmbientSummaryBridge(): AmbientSummaryModelBridge {
  return {
    generateAmbientSummaryEvent: async (_context: AmbientSummaryContext) => ({
      ok: false,
      errorCode: "native_unavailable",
      errorMessage: "Native ambient summary generation unavailable",
    }),
  };
}

export function createCloudFirstAmbientSummaryBridge(options: { shouldUseCloud?: () => boolean } = {}): AmbientSummaryModelBridge {
  const local = createLocalAmbientSummaryBridge();
  return {
    generateAmbientSummaryEvent: async (context: AmbientSummaryContext) => {
      if (options.shouldUseCloud && !options.shouldUseCloud()) {
        return local.generateAmbientSummaryEvent(context);
      }
      try {
        if (options.shouldUseCloud && !options.shouldUseCloud()) {
          return local.generateAmbientSummaryEvent(context);
        }
        const result = await summarizeAmbientWithCloud(context);
        return {
          ok: true,
          draft: result.draft,
          modelId: result.modelId,
          generationMethod: "cloud_llm",
          primarySourceLabel: "Ambient summary",
        };
      } catch (err) {
        const fallback = await local.generateAmbientSummaryEvent(context);
        return fallback.ok
          ? fallback
          : {
            ok: false,
            errorCode: "cloud_summary_failed",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
      }
    },
  };
}
