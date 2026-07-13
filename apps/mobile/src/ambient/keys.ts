/**
 * Ambient 源键（canonical）：master 开关 patch consent 时遍历全部源；
 * per-source 设置页也用它列全 9 个源。值 = 各 source 的 `.key`
 * （apps/mobile/src/ambient/sources/*），和后端 `pai_user_settings.
 * ambient_sources` / web `@/services/ambient/keys` 同一套 slug。
 * 顺序对齐 runtime.ts 的 `sources` 启动序。
 */
export const AMBIENT_SOURCE_KEYS = [
  "location",
  "device_state",
  "sound_classifier",
  "audio_route",
  "calendar",
  "health",
  "visit",
  "activity",
  "focus",
  "pin_hardware",
] as const;

export type AmbientSourceKey = (typeof AMBIENT_SOURCE_KEYS)[number];

/**
 * master 开关/设置面板批量操作用的键——pin_hardware 由 Connect > Devices
 * 的管理页管理（连接即录、与手机收录互斥），不参与「一键全开」；
 * master 关闸（隐私总开关）时仍然连它一起关。
 */
export const AMBIENT_BULK_SOURCE_KEYS: readonly AmbientSourceKey[] =
  AMBIENT_SOURCE_KEYS.filter((key) => key !== "pin_hardware");
