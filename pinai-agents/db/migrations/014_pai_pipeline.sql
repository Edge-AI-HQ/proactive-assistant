-- Pipeline runs + card evaluations + intent state.
-- 1:1 from plugin proactive.db: pipeline_runs, card_evaluations,
-- intent_card_state, intent_thread_state. CardOutcome / ChatDecision /
-- ThreadDecision enums kept verbatim.

CREATE TABLE pai_pipeline_runs (
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                     TEXT NOT NULL,
  run_id                 TEXT NOT NULL,
  status                 TEXT NOT NULL,
  total_iterations       INTEGER,
  final_cards            JSONB,
  iterations             JSONB,
  error                  TEXT,
  artifact_path          TEXT,
  subagent_run_id        TEXT,
  subagent_session_key   TEXT,
  trigger                TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_pai_pipeline_started
  ON pai_pipeline_runs (user_id, started_at DESC);
CREATE INDEX idx_pai_pipeline_status_started
  ON pai_pipeline_runs (user_id, status, started_at DESC);

CREATE TABLE pai_card_evaluations (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id              TEXT NOT NULL,
  run_id               TEXT NOT NULL,
  intent_key           TEXT,
  basket               TEXT,
  dim_relevance        REAL,
  dim_actionability    REAL,
  dim_why_now          REAL,
  dim_novelty          REAL,
  dim_decision_compress REAL,
  overall              REAL,
  pass                 BOOLEAN NOT NULL DEFAULT TRUE,
  evaluator            TEXT NOT NULL DEFAULT 'self',
  feedback_text        TEXT,
  evaluated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX idx_pai_card_eval_run
  ON pai_card_evaluations (user_id, run_id);
CREATE INDEX idx_pai_card_eval_basket_score
  ON pai_card_evaluations (user_id, basket, overall DESC);

CREATE TABLE pai_intent_card_state (
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id               TEXT NOT NULL,
  intent_key            TEXT NOT NULL,
  goal_basket           TEXT NOT NULL,
  -- CardOutcome enum: confirm, modify, dismiss, snooze, none
  latest_outcome        TEXT NOT NULL DEFAULT 'none',
  outcome_at            TIMESTAMPTZ,
  has_deep_chat         BOOLEAN NOT NULL DEFAULT FALSE,
  -- ChatDecision enum: advance, refine, hold, suppress, none
  latest_chat_decision  TEXT NOT NULL DEFAULT 'none',
  latest_chat_summary   TEXT,
  next_angles           JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE pai_intent_thread_state (
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intent_key               TEXT NOT NULL,
  goal_basket              TEXT NOT NULL,
  latest_card_id           TEXT,
  latest_generated_at      TIMESTAMPTZ,
  latest_card_outcome      TEXT NOT NULL DEFAULT 'none',
  has_any_confirmed_card   BOOLEAN NOT NULL DEFAULT FALSE,
  has_any_dismissed_card   BOOLEAN NOT NULL DEFAULT FALSE,
  latest_chat_decision     TEXT NOT NULL DEFAULT 'none',
  latest_chat_summary      TEXT,
  next_angles              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- ThreadDecision enum: advance, refine, hold, suppress
  thread_decision          TEXT NOT NULL DEFAULT 'hold',
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, intent_key)
);
CREATE INDEX idx_pai_intent_thread_updated
  ON pai_intent_thread_state (user_id, updated_at DESC);
CREATE INDEX idx_pai_intent_thread_basket
  ON pai_intent_thread_state (user_id, goal_basket);
