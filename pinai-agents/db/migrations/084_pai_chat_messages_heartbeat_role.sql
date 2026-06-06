-- pai_chat_messages.role — 放开 'heartbeat'。
--
-- proactive 的心跳输入(~30s ambient tick,喂给 agent 的 timeline window 文本)
-- 此前只通过 FrameBus 以 proactive:tick frame 推给前端(live-only,从不落库),
-- 重连 / 刷新即丢失。Debug 视图要看的恰是这些不进 pai_chat_messages 的心跳活动
-- 和 silent turn,所以把心跳输入作为一行落库(role='heartbeat',debug-only),让
-- 重连和 Debug 开关都能从表里重建 transcript。
--
-- 这**取代**了 080 注释里"silent tick 不落库 → 表不随心跳增长"的前提:silent
-- turn 现在也落库(role='heartbeat' 输入行 + trigger='tick' 的 assistant 行),
-- 靠不含 notify_user 被前端归类 debug-only(默认隐藏)。这是有意的 trade-off,
-- 代价要讲清楚:这张表从此**会随心跳增长**——每个 tick 至少 1 行 heartbeat
-- 输入,silent 时再 1 行 assistant。
-- /api/conversation/history 的 include_debug=false(默认)只在 SQL 层把这些行
-- 滤掉**不显示**,行本身仍在表里。换来的是 Debug 视图重连/刷新可从表重建
-- (frames 不落库,见 framebus.py)。**必须配套 retention**(定期清理
-- role='heartbeat' / silent tick 行)才不会长期堆积,否则重蹈 proactive
-- checkpoint 无界增长的坑;retention 尚未实现(follow-up)。
--
-- 放宽 CHECK(允许更多取值)是 additive:不影响任何现有行——历史行的 role 都
-- 是 'user' / 'assistant'。约束名沿用 079 inline CHECK 的自动命名
-- (<table>_<column>_check)。

ALTER TABLE pai_chat_messages
  DROP CONSTRAINT pai_chat_messages_role_check,
  ADD CONSTRAINT pai_chat_messages_role_check
    CHECK (role IN ('user', 'assistant', 'heartbeat'));
