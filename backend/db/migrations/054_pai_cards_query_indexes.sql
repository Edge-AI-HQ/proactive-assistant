-- Speed up /api/cards cold loads by matching its run ordering and
-- latest-feedback lookup patterns.

CREATE INDEX IF NOT EXISTS idx_pai_pipeline_cards_completed
  ON pai_pipeline_runs (user_id, status, completed_at DESC)
  WHERE final_cards IS NOT NULL
    AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pai_feedback_card_latest
  ON pai_feedback_events (user_id, intent_card_id, created_at DESC)
  WHERE intent_card_id IS NOT NULL
    AND (
      action IN ('confirm', 'modify', 'dismiss', 'snooze', 'complete')
      OR kind IN ('dismiss', 'snooze')
    );
