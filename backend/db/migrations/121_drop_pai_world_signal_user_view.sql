-- Drop pai_world_signal_user_view (W6 — world fully migrated to events).
--
-- World news is now an L1 event (event_type='world_news', projected per-user by
-- world_scoring gated on salience). The per-user view is fully retired: per-user
-- state (salience / recency / reference) lives in the event's structured +
-- occurred_at + the event reference triple, read via events_search like any
-- other event. All readers (generation phase-1 seed, reward personal-data
-- snapshot) and writers (generator auto-consume, /api/agent/world/score|consume|
-- reference) are deleted in the same change.
--
-- DROP TABLE cascades the table's own indexes, its RLS policies (023), and the
-- reward-role grants (107). The globally-shared pai_world_signals L0 table stays
-- — world_scoring still reads it to project the per-user world_news events.

DROP TABLE IF EXISTS pai_world_signal_user_view;
