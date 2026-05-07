-- Pin AI core per-user state.
--
-- 1:1 translation of plugin SQLite tables (proactive.db):
--   profile, goals, user_settings, app_state.
--
-- Differences from SQLite source:
--   * Multi-tenant: every row gets `user_id BIGINT NOT NULL REFERENCES users`.
--     PK changes from single-col TEXT to composite (user_id, original_pk).
--     `user_settings` was a singleton (id=1); becomes (user_id) PK.
--   * `*_json` TEXT columns → JSONB.
--   * ISO-string TEXT timestamps → TIMESTAMPTZ.
--   * Status / kind columns keep their CHECK constraint enums verbatim.
-- Reference triple (reference_count / last_referenced_at / referenced_by_runs)
-- on `goals` retained — used by reference-count bumping in agent runs.

CREATE TABLE pai_profile (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  locale         TEXT NOT NULL DEFAULT 'en-US',
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  summary        TEXT,
  facts          JSONB NOT NULL DEFAULT '{}'::jsonb,
  preferences    JSONB NOT NULL DEFAULT '{}'::jsonb,
  constraints    JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE pai_goals (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  key                TEXT NOT NULL,
  title              TEXT NOT NULL,
  priority           TEXT NOT NULL DEFAULT 'medium',
  status             TEXT NOT NULL DEFAULT 'active',
  summary            TEXT,
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, key)
);
CREATE INDEX idx_pai_goals_user_status ON pai_goals (user_id, status);

CREATE TABLE pai_user_settings (
  user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation_language  TEXT NOT NULL DEFAULT 'zh-Hans',
  auto_generate        BOOLEAN NOT NULL DEFAULT FALSE,
  auto_dreaming        BOOLEAN NOT NULL DEFAULT FALSE,
  auto_crystallize     BOOLEAN NOT NULL DEFAULT TRUE,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pai_app_state (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  namespace   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL DEFAULT 'null'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, namespace, key)
);
