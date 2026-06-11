/**
 * Phase 2 shim —— 实现已迁 @pin-ai/state（queries/user-settings.ts，TQ 版：
 * module cache + listeners 被共享 query cache 取代，retry/timeout 语义保留）。
 * 保留本壳是因为多个组件测试 vi.mock 本路径；组件 import 与测试 mock 在
 * 分层 Phase 4 统一改到 @pin-ai/state 后删除本文件。
 */
export {
  useUserSettings,
  type AmbientSourceConsent,
  type UserSettings,
  type UserSettingsPatch,
  type UseUserSettingsResult,
} from "@pin-ai/state";
