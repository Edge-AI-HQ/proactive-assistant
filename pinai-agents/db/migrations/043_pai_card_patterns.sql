-- Pattern-driven card generation: schema for shared pattern library +
-- per-user fingerprint tables.
--
-- Design split (see docs/plans/2026-05-15-pattern-driven-card-generation.mdx):
--   * pai_card_patterns          — global cross-user pattern library (no user_id).
--   * pai_card_pattern_demos     — global redacted demo cards keyed by pattern.
--   * pai_card_pattern_hits      — per-user; which patterns matched on which run/card.
--   * pai_user_pattern_pref      — per-user pattern fingerprint (CTR / suppress).
--   * pai_user_intent_pref       — per-user intent fingerprint (CTR by intent/basket).
--
-- The first two are read by all users; the latter three are user-scoped and
-- get the standard RLS policy pair used by 023_pai_rls.sql.

CREATE TABLE pai_card_patterns (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  abstract          TEXT NOT NULL,
  signals_required  JSONB NOT NULL DEFAULT '[]'::jsonb,
  trigger_dsl       JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent            TEXT NOT NULL,
  card_skeleton     JSONB NOT NULL DEFAULT '{}'::jsonb,
  specializations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  surprise_init     TEXT CHECK (surprise_init IN ('h', 'm', 'l')),
  practical_init    TEXT CHECK (practical_init IN ('h', 'm', 'l')),
  tier              TEXT NOT NULL CHECK (tier IN ('cold_start_friendly', 'warmup', 'mature')),
  status            TEXT NOT NULL CHECK (status IN ('pending_review', 'active', 'retired')),
  source            TEXT NOT NULL CHECK (source IN ('seed', 'ai_extracted', 'manual')),
  base_hit_rate     REAL NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at        TIMESTAMPTZ
);

CREATE INDEX idx_pai_card_patterns_status ON pai_card_patterns (status);
CREATE INDEX idx_pai_card_patterns_category ON pai_card_patterns (category);
CREATE INDEX idx_pai_card_patterns_tier ON pai_card_patterns (tier);

CREATE TABLE pai_card_pattern_demos (
  id              TEXT PRIMARY KEY,
  pattern_id      TEXT NOT NULL REFERENCES pai_card_patterns(id) ON DELETE CASCADE,
  subtype         TEXT,
  scenario        TEXT NOT NULL,
  card_json       JSONB NOT NULL,
  signals_used    JSONB NOT NULL DEFAULT '[]'::jsonb,
  why_surprise    TEXT,
  why_practical   TEXT,
  wow_level       INT CHECK (wow_level BETWEEN 1 AND 5),
  source          TEXT NOT NULL CHECK (source IN ('seed', 'golden', 'anti')),
  redacted        BOOLEAN NOT NULL DEFAULT false,
  source_card_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pai_card_pattern_demos_pattern_id
  ON pai_card_pattern_demos (pattern_id);
CREATE INDEX idx_pai_card_pattern_demos_source
  ON pai_card_pattern_demos (source);

CREATE TABLE pai_card_pattern_hits (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id               TEXT NOT NULL,
  card_id              TEXT NOT NULL,
  pattern_id           TEXT NOT NULL REFERENCES pai_card_patterns(id),
  subtype              TEXT,
  evidence             JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_fit_score       REAL,
  combined_score       REAL,
  pattern_grounding_ok BOOLEAN,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id, pattern_id)
);

CREATE INDEX idx_pai_card_pattern_hits_pattern_id
  ON pai_card_pattern_hits (pattern_id);
CREATE INDEX idx_pai_card_pattern_hits_run_id
  ON pai_card_pattern_hits (user_id, run_id);

CREATE TABLE pai_user_pattern_pref (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern_id     TEXT NOT NULL REFERENCES pai_card_patterns(id) ON DELETE CASCADE,
  hit_count      INT NOT NULL DEFAULT 0,
  open_count     INT NOT NULL DEFAULT 0,
  dismiss_count  INT NOT NULL DEFAULT 0,
  last_hit_at    TIMESTAMPTZ,
  suppress_until TIMESTAMPTZ,
  hit_rate       REAL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, pattern_id)
);

CREATE TABLE pai_user_intent_pref (
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent           TEXT NOT NULL,
  basket           TEXT NOT NULL DEFAULT '',
  ctr_30d          REAL,
  ctr_7d           REAL,
  last_open_at    TIMESTAMPTZ,
  last_dismiss_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, intent, basket)
);

-- RLS for the three user-scoped tables. Same policy shape as 023_pai_rls.sql.
ALTER TABLE pai_card_pattern_hits ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_card_pattern_hits_user_scope ON pai_card_pattern_hits
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_card_pattern_hits_service_role ON pai_card_pattern_hits
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_user_pattern_pref ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_user_pattern_pref_user_scope ON pai_user_pattern_pref
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_user_pattern_pref_service_role ON pai_user_pattern_pref
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');

ALTER TABLE pai_user_intent_pref ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_user_intent_pref_user_scope ON pai_user_intent_pref
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_user_intent_pref_service_role ON pai_user_intent_pref
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
