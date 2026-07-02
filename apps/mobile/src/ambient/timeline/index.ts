/**
 * RN ambient timeline 公开入口。store / pipeline / 模型桥 + refreshTimeline，
 * 状态面板与 ingest 链路从这里取。类型从 @pin-ai/core 透出（双端同源）。
 */
export type {
  AmbientCandidateWindow,
  AmbientTimelineEvent,
  AmbientTimelineStore,
  TimelineStoreStatus,
} from "@pin-ai/core";

export { getAmbientTimelineStore } from "./store";
export { createAmbientTimelineModelBridge } from "./models";
export { getAmbientTimelinePipeline, refreshTimeline } from "./pipeline";
