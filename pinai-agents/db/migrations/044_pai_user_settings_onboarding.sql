-- First-run onboarding completion timestamp.
--
-- NULL = the user has not yet finished (or skipped through) the first-run
-- onboarding flow. The SPA reads this on every load: NULL → render
-- <OnboardingFlow />, non-NULL → render the main shell. Skipping a step
-- still counts as "done" — we never re-prompt automatically once stamped.
--
-- Writes are one-shot: the route only stamps NOW() when the client passes
-- onboarding_completed=true. Manual reset (e.g. "redo onboarding" from a
-- settings page) is a future feature; until then the column is monotonic.

ALTER TABLE pai_user_settings
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
