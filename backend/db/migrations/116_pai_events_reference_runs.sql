-- pai_events 增加 referenced_by_runs —— 客观信号链的 provenance(WP3,doc §五.5/§七)。
--
-- reference 三元组在旧 pai_memory/signals/skill 是死字段(痛点⑦:设计在、从不
-- bump)。WP3 把这条「使用驱动重要性」链通电:events_search 每次命中即 bump
-- reference_count + last_referenced_at(111 已有列)+ 把检索的 agent run 追加进
-- referenced_by_runs(本列)。referenced_by_runs 是命中来源的审计轨迹,喂给
-- 排序(5.5)/ formation gating(8.1)/ forgetting —— 区分「被同一 run 反复读」
-- 和「被多个独立 run 引用」(后者才是真·重要),所以按 run_id 去重 append。
--
-- 故意不建索引、也不进 events 读路径的 _READ_COLUMNS:这列随引用无界增长,
-- 拖进检索的 Sort 会 spill(同 embedding/pai_memory 的教训);需要时按 user_id
-- + id 直接点查即可。RLS 沿用表级 policy(111),列级无需新策略。

ALTER TABLE pai_events
  ADD COLUMN IF NOT EXISTS referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb;
