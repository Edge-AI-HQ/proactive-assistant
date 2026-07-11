/**
 * RN ambient timeline 公开入口（durable store 读取面）。端侧 LLM pipeline /
 * 模型桥已随 on-device model sunset 删除；timeline 显示读本地 store，聚合/
 * 摘要由后端 memory 架构承担。类型从 @pin-ai/core 透出。
 */
export type {
  AmbientCandidateWindow,
  AmbientTimelineEvent,
  AmbientTimelineStore,
  TimelineStoreStatus,
} from "@pin-ai/core";

export { getAmbientTimelineStore, resetAmbientTimelineStore } from "./store";
