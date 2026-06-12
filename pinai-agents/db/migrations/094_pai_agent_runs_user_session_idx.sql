-- /api/cards now derives each card's latest execution-run status from
-- pai_agent_runs (card_run_map CTE in web/routes/ui/runs_and_cards.py:
-- per-user DISTINCT ON (session_id) ... ORDER BY session_id, created_at DESC).
-- The table only had (session_id, created_at) and a partial active-status
-- index — neither serves a per-user scan, so the 30s /cards poll would seq-
-- scan the cross-user table as it grows. This index serves the CTE's
-- user_id filter + ordering; the LIKE 'card-thread-%' prefix stays a
-- per-row Filter (default collation btree can't range-scan LIKE), which is
-- fine at per-user run counts — revisit with text_pattern_ops or a partial
-- index if it ever shows up in EXPLAIN as a problem.
CREATE INDEX idx_pai_agent_runs_user_session
  ON pai_agent_runs (user_id, session_id, created_at DESC);
