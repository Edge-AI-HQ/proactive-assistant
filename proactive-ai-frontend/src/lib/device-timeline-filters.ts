/**
 * 过渡 shim —— 实现已下沉 @pin-ai/core（domain/device-timeline-filters，
 * 纯日期逻辑，web/RN/backend 跨端）。旧路径保持可用。
 */
export {
  DEVICE_TIMELINE_QUICK_FILTERS,
  formatLocalDateInput,
  getDeviceTimelineDateRange,
  type DeviceTimelineDayFilter,
  type DeviceTimelineDateRange,
} from "@pin-ai/core";
