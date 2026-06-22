-- Evolution runs — unified ledger for dream / crystallize / connector evolve /
-- consolidation. trigger_kind discriminator lets one table hold all variants.
-- refs_consumed / refs_produced stored inline as JSONB (no subtables in source).

CREATE TABLE pai_evolution_runs (
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                       TEXT NOT NULL,
  trigger_kind             TEXT NOT NULL
                           CHECK (trigger_kind IN
                                  ('chat_burst', 'daily_dream', 'manual',
                                   'on_event', 'consolidation')),
  status                   TEXT NOT NULL
                           CHECK (status IN ('running', 'completed', 'failed')),
  context_summary          TEXT,
  window_start             TIMESTAMPTZ,
  window_end               TIMESTAMPTZ,
  memories_written         INTEGER NOT NULL DEFAULT 0,
  memories_archived        INTEGER NOT NULL DEFAULT 0,
  memories_superseded      INTEGER NOT NULL DEFAULT 0,
  profile_updated          BOOLEAN NOT NULL DEFAULT FALSE,
  profile_changed_keys     JSONB NOT NULL DEFAULT '[]'::jsonb,
  skills_added             INTEGER NOT NULL DEFAULT 0,
  skills_updated           INTEGER NOT NULL DEFAULT 0,
  skills_disabled          INTEGER NOT NULL DEFAULT 0,
  signals_consumed         INTEGER NOT NULL DEFAULT 0,
  refs_consumed            JSONB NOT NULL DEFAULT '{}'::jsonb,
  refs_produced            JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_excerpt           TEXT,
  llm_tokens               INTEGER,
  duration_ms              INTEGER,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  error_message            TEXT,
  details                  JSONB,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_evol_runs_started
  ON pai_evolution_runs (user_id, started_at DESC);
CREATE INDEX idx_pai_evol_runs_trigger_started
  ON pai_evolution_runs (user_id, trigger_kind, started_at DESC);
