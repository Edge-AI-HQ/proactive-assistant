-- Sync-B1（本地同步引擎 delta 协议，research/2026-06-11-local-sync-engine.mdx §4.4）:
-- pai_chat_threads 补 updated_at，作为 /api/sync/threads 的增量游标
-- （复合 cursor: (updated_at, thread_id) tie-break）。应用层在写路径维护
-- （insert 走 DEFAULT；bump_after_send 显式 SET）——与 pai_background_tasks
-- 的「业务逻辑显式更新」惯例一致，不用触发器。
-- pai_chat_messages 不需要动：id BIGINT IDENTITY 单调递增即天然 cursor，
-- 且行 append-only 不可变（/api/sync/messages 用现有
-- idx_pai_chat_messages_thread (user_id, thread_id, id DESC) 索引反向扫）。

ALTER TABLE pai_chat_threads
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX idx_pai_chat_threads_user_updated
    ON pai_chat_threads (user_id, updated_at, thread_id);
