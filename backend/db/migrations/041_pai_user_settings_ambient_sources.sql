-- Per-source consent for mobile ambient ingest.
--
-- Privacy invariant: ambient sound classifier, location, visit
-- monitoring, etc. are off by default. The mobile client (ambient-ai
-- Capacitor plugin) reads this map at boot and starts ONLY the sources
-- the user has explicitly opted into. Empty map (the column default)
-- means "no ambient capture" — login alone never starts a source.
--
-- Shape: { "<source_key>": { "enabled": <bool>, "updated_at": "<iso>" }, ... }
-- Source keys mirror the @pin/capacitor-ambient-ai facade
-- (e.g. "sound_classifier", "visit", "activity", "location",
-- "barometer", "media_notebook"). Unknown keys are tolerated so a
-- newer mobile client can introduce a source before the backend
-- enumerates it.
ALTER TABLE pai_user_settings
  ADD COLUMN ambient_sources JSONB NOT NULL DEFAULT '{}'::jsonb;
