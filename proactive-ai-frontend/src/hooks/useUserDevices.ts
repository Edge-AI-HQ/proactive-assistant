/**
 * Phase 2 shim —— 实现已迁 @pin-ai/state（queries/user-devices.ts，TQ 版：
 * window 的 DEVICE_REGISTERED_EVENT 自制事件已删，注册路径直接 invalidate，
 * 见 lib/devices.ts emitDeviceRegistered）。
 * 保留本壳是因为多个组件测试 vi.mock 本路径；分层 Phase 4 统一清理。
 */
export { useUserDevices, type UseUserDevicesApi } from "@pin-ai/state";
