-- L2 画像 MEMORY 段已砍(doc 2026-06-23-lifelong-memory-system §六-288)。
--
-- 原 MEMORY = "agent 主观笔记",和 USER / L1 events 定位重叠,且是 drift 雷区
-- (LLM 自由编辑无约束文本)。职责重分配:
--   * 关于用户的笔记 + 负向 lessons → USER 画像
--   * agent 想临时记一条        → event_append 进 L1 pai_events
--   * 程序性学习               → skills
-- 画像从 6 段收窄到 5 段(IDENTITY / SOUL / TOOLS / USER / GOALS)。
--
-- 112 的 slot CHECK 是 inline 无名列约束,PostgreSQL 自动命名
-- pai_user_strings_slot_check。先删 MEMORY 行(否则收窄后的 CHECK 会拒绝旧行),
-- 再换掉约束。IF EXISTS 幂等(本地/dev 可能已手动清过),照搬 114 的写法。
DELETE FROM pai_user_strings WHERE slot = 'MEMORY';

ALTER TABLE pai_user_strings
  DROP CONSTRAINT IF EXISTS pai_user_strings_slot_check;
ALTER TABLE pai_user_strings
  ADD CONSTRAINT pai_user_strings_slot_check
  CHECK (slot IN ('IDENTITY', 'SOUL', 'TOOLS', 'USER', 'GOALS'));
