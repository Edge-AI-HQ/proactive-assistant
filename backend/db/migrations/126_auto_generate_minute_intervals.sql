-- Auto-generate revival (design: proactive-card-generation §三 + cache 架构).
--
-- The settings → schedule bridge died in the Proactive Sunset (#151); the
-- setting stayed in the UI, lying to users ("Auto Generate ON · every 12h"
-- while nothing ever fired). The agentic tick generator + anchor cache
-- architecture (migration 125) makes high-frequency ticks affordable, so the
-- setting comes back to life with minute-level presets: 1/3/5/15/30/60 min.
--
-- * CHECK widens 15–1440 → 1–1440 (minute presets were illegal before).
-- * DEFAULT 720 → 60: 720 (12h) is not one of the new presets, and no
--   existing row's value was ever consumed (the bridge didn't exist), so the
--   stored 720s carry no user intent — normalize them to the new default.

ALTER TABLE pai_user_settings
  DROP CONSTRAINT IF EXISTS pai_user_settings_auto_generate_interval_minutes_check;

ALTER TABLE pai_user_settings
  ADD CONSTRAINT pai_user_settings_auto_generate_interval_minutes_check
    CHECK (auto_generate_interval_minutes BETWEEN 1 AND 1440);

ALTER TABLE pai_user_settings
  ALTER COLUMN auto_generate_interval_minutes SET DEFAULT 60;

UPDATE pai_user_settings
   SET auto_generate_interval_minutes = 60
 WHERE auto_generate_interval_minutes = 720;
