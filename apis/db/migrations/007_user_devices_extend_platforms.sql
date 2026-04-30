-- Migration 007: 放宽 user_devices.platform 约束,加 model 字段。
-- 配套 docs/plans/2026-04-28-device-ingest-unification.mdx。
--
-- Why: 把所有 device(手机 / omi 一类硬件 / 未来传感器)收敛到同一张 user_devices
-- 表 + 同一个 /devices/ingest 接口。原 platform CHECK 只允许 ios/android/web,
-- 把硬件类型挡在外面;放宽到含 wearable / sensor / embedded。
--
-- model 字段是可选的子型号标签('iphone_15' / 'omi_pendant_v1' / 'pixel_8'),
-- 平时只有展示用,RPC / fan-out 逻辑不依赖。

-- platform CHECK 放宽。Postgres 不支持 IF EXISTS 在 DROP CONSTRAINT 之前的复合
-- 形式直接判,直接 DROP IF EXISTS 是合法的。
ALTER TABLE user_devices DROP CONSTRAINT IF EXISTS user_devices_platform_check;
ALTER TABLE user_devices ADD CONSTRAINT user_devices_platform_check
  CHECK (platform IN ('ios', 'android', 'web', 'wearable', 'sensor', 'embedded'));

-- model: 子型号标签。NULL 表示不指定(老数据全部保持 NULL,不影响)。
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS model TEXT;
