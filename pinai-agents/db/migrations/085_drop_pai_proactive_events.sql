-- Drop pai_proactive_events — zero readers.
--
-- 070 provisioned this table as a "future training negative-label corpus +
-- say delivery ledger", and 075 added a per-thread index. But no consumer was
-- ever built: nothing in the codebase SELECTs it. The only writers were the
-- worker's silent-turn finalize and the notify_user /emit callback — both
-- removed in this same release. proactive turns (silent or notify_user) are
-- fully reconstructable from pai_chat_messages (heartbeat rows + trigger='tick'
-- + the notify_user tool-call part), which is what the frontend actually reads.
--
-- Expand-contract note: this is the contract step. Safe to drop + stop writing
-- in one release because there is no external writer and no reader anywhere.
-- DROP TABLE cascades the RLS policies (070) and both indexes (070, 075).
--
-- pai_proactive_state (the window cursor, 069) is UNRELATED and stays — it is
-- still read/written by services/proactive_window.py.

DROP TABLE IF EXISTS pai_proactive_events;
