/**
 * RN ambient timeline pipeline 单例 + refreshTimeline 触发器。
 * 复用 core 的 LocalAmbientTimelinePipeline（纯逻辑），注入 RN 的 durable store
 * + 端侧 LLM 模型桥。状态面板的 "Trigger" 调 refreshTimeline → regenerateDay。
 */
import {
  LocalAmbientTimelinePipeline,
  type AmbientTimelinePipeline,
} from "@pin-ai/core";

import { getAmbientTimelineStore } from "./store";
import { createAmbientTimelineModelBridge } from "./models";

let singleton: AmbientTimelinePipeline | null = null;

export function getAmbientTimelinePipeline(): AmbientTimelinePipeline {
  if (!singleton) {
    singleton = new LocalAmbientTimelinePipeline(
      getAmbientTimelineStore(),
      createAmbientTimelineModelBridge(),
    );
  }
  return singleton;
}

/** 立即（重新）生成某天的时间线摘要——状态面板 Trigger 钮调用。 */
export async function refreshTimeline(
  localDate?: string,
  options?: { force?: boolean },
): Promise<void> {
  await getAmbientTimelinePipeline().regenerateDay(localDate, options);
}
