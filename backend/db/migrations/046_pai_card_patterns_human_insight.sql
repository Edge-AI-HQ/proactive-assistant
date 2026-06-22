ALTER TABLE pai_card_patterns
  ADD COLUMN IF NOT EXISTS human_insight TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN pai_card_patterns.human_insight IS
  'Human motivation or psychological hook this pattern uses to make the card compelling.';
