import { summarizeAmbientWithCloud } from "@pin-ai/core";
import type { AmbientSummaryContext } from "./timeline/summary-context";
import { ambientTimelineModels } from "./timeline/models";
import type { AmbientSummaryModelBridge } from "./timeline/scheduled-summary";

export function createLocalAmbientSummaryBridge(): AmbientSummaryModelBridge {
  return {
    generateAmbientSummaryEvent: async (context: AmbientSummaryContext) => {
      if (!ambientTimelineModels.generateAmbientSummaryEvent) {
        return {
          ok: false,
          errorCode: "native_unavailable",
          errorMessage: "Native ambient summary generation unavailable",
        };
      }
      const result = await ambientTimelineModels.generateAmbientSummaryEvent(context);
      return result.ok
        ? {
          ...result,
          generationMethod: "local_llm",
          primarySourceLabel: "On-device summary",
        }
        : result;
    },
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
