-- lifelong-memory sunset: DROP 退役的老记忆架构表。
--
-- 三层新架构(L0 pai_raw / L1 pai_events / L2 pai_user_strings)已全面接管,
-- 所有代码消费者在前序 commit(S1/S4/S5-A/S5-B)切走:
--   pai_memory          → L1 pai_events(evolve curate;summarize_outputs 已去 dead read)
--   pai_personal_signals → L1 pai_events(device signal_only 早已写 pai_raw→projector→event)
--   pai_profile         → L2 pai_user_strings(USER slot);timezone 已在 113 迁
--                         pai_user_settings;display_name/locale 无消费者随表删
--   pai_goals           → L2 pai_user_strings(GOALS slot)
--   pai_preference_records → L1 pai_events(event_type=preference;preferences_agent
--                         路线 A 内部改写 events,operator-source 信任契约保留)
-- (pai_timeline_events 已在 111 删,不在此列)
--
-- ⚠️ typed raw 表(pai_raw_gmail_messages 等 32 张)不退役、不在此列 ——
--    connector ingest 主力路径仍 INSERT INTO pai_raw_*;L0 完全统一到 generic
--    pai_raw 是独立迁移,不在本次 sunset 范围。

-- embedding pipeline 不再处理 pai_memory/pai_personal_signals:先清队列里指向退役
-- 表的 pending 行(platform/embeddings.py 的 allowlist 已同步去掉这两表),再把
-- table_name CHECK 收窄到仍在产 embedding 的两张表。
DELETE FROM pai_embedding_queue
WHERE table_name IN ('pai_memory', 'pai_personal_signals');

ALTER TABLE pai_embedding_queue
  DROP CONSTRAINT IF EXISTS pai_embedding_queue_table_name_check;
ALTER TABLE pai_embedding_queue
  ADD CONSTRAINT pai_embedding_queue_table_name_check
  CHECK (table_name IN ('pai_world_signals', 'pai_events'));

-- DROP 退役表。CASCADE 清理依赖对象(index / FK / RLS policy / 自引用约束等)。
-- IF EXISTS 保证幂等(本地/dev 可能已手动清过)。
DROP TABLE IF EXISTS pai_memory CASCADE;
DROP TABLE IF EXISTS pai_personal_signals CASCADE;
DROP TABLE IF EXISTS pai_profile CASCADE;
DROP TABLE IF EXISTS pai_goals CASCADE;
DROP TABLE IF EXISTS pai_preference_records CASCADE;
