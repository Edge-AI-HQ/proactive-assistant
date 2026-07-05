-- Device ingest 统一收尾 (P1/3):pai_raw_device 加 platform 列 + dedupe unique 收紧含 external_id。
-- 设计 SSOT: docs/plans/2026-06-30-device-ingest-unification.mdx
--
-- 背景:118 删 typed 表、119 拆域表后,所有 device 数据已在单表 pai_raw_device
-- (kind 判语义 + payload JSONB,external_id = device_id)。本 migration 补两件事:
--   1. platform 列 —— 多 device 的来源平台(ios/android/wearable/…)。是 device_id 的
--      immutable 派生,ingest 时从 pai_user_devices 写时反规范化;NOT 进 dedupe unique(冗余)。
--   2. dedupe unique 从 (user_id, kind, dedupe_key) 收紧到 (user_id, external_id, kind,
--      dedupe_key) —— 让同 platform 的多台设备(两台 iPhone,platform 都是 ios)物理隔离,
--      不再因 dedupe_key 撞而互相覆盖。external_id 恒为 device_id(见 raw_device._insert_raw),
--      不会 NULL。旧 unique 是新 unique 的前缀子集,只放松约束,现有行无冲突。
--
-- ⚠️ 应用后 raw_device._insert_raw 的 ON CONFLICT 子句必须同步含 external_id,否则
--    ON CONFLICT (user_id, kind, dedupe_key) 找不到匹配约束会报错(同 PR 一并改)。

-- 1. platform 列(nullable:历史行可能查不到注册表 → 留 NULL,新写入由 ingest 填)
ALTER TABLE pai_raw_device ADD COLUMN platform TEXT;

-- backfill:从注册表反查(external_id = device_id)
UPDATE pai_raw_device r
   SET platform = d.platform
  FROM pai_user_devices d
 WHERE d.device_id = r.external_id
   AND r.platform IS NULL;

-- 2. dedupe unique 收紧:加 external_id 前缀,同 platform 多设备隔离
DROP INDEX IF EXISTS idx_pai_raw_device_dedupe;
CREATE UNIQUE INDEX idx_pai_raw_device_dedupe
  ON pai_raw_device (user_id, external_id, kind, dedupe_key);
