-- Recreate the raw / signal tables that the (now reverted) timeline-event-store
-- work dropped, so this a156d05-based branch's code matches any database that
-- already ran migrations 064-077.
--
-- Context: migrations 065 / 067 / 073 destructively dropped pai_personal_signals,
-- pai_raw_device_health_observations, and 9 Composio connector raw tables once the
-- timeline_events store became the single agent-facing layer. This branch rolls the
-- code back to before that store exists, so connector_ingest / raw_device /
-- personal_signals / raw routes / device_ingest read & write these tables again.
--
-- yoyo is forward-only: on a DB that already applied 064-077 it will NOT roll those
-- back (their files are absent here), so the drops persist and the timeline tables
-- linger harmlessly. This migration re-adds exactly the 11 dropped tables. Their
-- data was empty when dropped (pre-launch — see the 065/067/073 headers), so this is
-- pure schema recreation, no data migration.
--
-- Fully idempotent (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP POLICY IF EXISTS before CREATE POLICY): on a fresh DB where 011-019/023/029/049
-- already built these tables it is a no-op; on an already-migrated DB where they were
-- dropped it rebuilds them. DDL copied verbatim from those source migrations.
--
-- No GRANTs to replay: these are public-schema tables owned by the migration role;
-- 024 REVOKEs pai_chat from schema public entirely, and there are no per-table grants.
-- The CASCADE drops only removed each table's indexes + RLS policies, both rebuilt here.

-- ─────────────────────────────────────────────────────────────────────────────
-- pai_personal_signals  (dropped by 065; base 011 + embedding 029 + updated_at 049)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pai_personal_signals (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  salience           REAL NOT NULL DEFAULT 0,
  confidence         REAL NOT NULL DEFAULT 0,
  dedupe_key         TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  available_at       TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ,
  source             TEXT NOT NULL DEFAULT 'device',
  device_id          TEXT,
  subject            TEXT,
  source_raw_table   TEXT,
  source_raw_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'consumed', 'archived')),
  consumed_by_run_id TEXT,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_psignals_dedupe
  ON pai_personal_signals (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_psignals_status_time
  ON pai_personal_signals (user_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pai_psignals_kind_time
  ON pai_personal_signals (user_id, kind, occurred_at DESC);
-- 029: signals are semantically queryable too.
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE pai_personal_signals ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_pai_personal_signals_embedding_hnsw
  ON pai_personal_signals USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
-- 049: last server-side mutation time, distinct from first ingest.
ALTER TABLE pai_personal_signals
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_pai_psignals_kind_updated_at
  ON pai_personal_signals (user_id, kind, updated_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- pai_raw_device_health_observations  (dropped by 067; from 019)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pai_raw_device_health_observations (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  observation_type   TEXT NOT NULL,
  metric             TEXT,
  value              REAL,
  unit               TEXT,
  start_at           TIMESTAMPTZ,
  end_at             TIMESTAMPTZ,
  local_date         DATE,
  source_app         TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_device_health_dedupe
  ON pai_raw_device_health_observations (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_device_health_device_time
  ON pai_raw_device_health_observations (user_id, device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pai_raw_device_health_metric_time
  ON pai_raw_device_health_observations (user_id, metric, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pai_raw_device_health_local_date
  ON pai_raw_device_health_observations (user_id, device_id, local_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- Composio connector raw tables  (dropped by 073; 9 of them, from 016 / 017 / 018)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Gmail (016) ──
CREATE TABLE IF NOT EXISTS pai_raw_gmail_messages (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  thread_id          TEXT,
  from_addr          TEXT,
  to_addrs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject            TEXT,
  snippet            TEXT,
  body               TEXT,
  label_ids          JSONB NOT NULL DEFAULT '[]'::jsonb,
  internal_date      TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_gmail_dedupe
  ON pai_raw_gmail_messages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_gmail_thread ON pai_raw_gmail_messages (user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_pai_raw_gmail_occurred
  ON pai_raw_gmail_messages (user_id, occurred_at DESC);

-- ── Google Calendar (016) ──
CREATE TABLE IF NOT EXISTS pai_raw_gcal_events (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  calendar_id        TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  title              TEXT,
  description        TEXT,
  location           TEXT,
  start_at           TIMESTAMPTZ,
  end_at             TIMESTAMPTZ,
  attendees          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, calendar_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_gcal_dedupe
  ON pai_raw_gcal_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_gcal_start
  ON pai_raw_gcal_events (user_id, start_at DESC);

-- ── Google Drive (016) ──
CREATE TABLE IF NOT EXISTS pai_raw_gdrive_files (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  file_id            TEXT NOT NULL,
  name               TEXT,
  mime_type          TEXT,
  modified_time      TIMESTAMPTZ,
  created_time       TIMESTAMPTZ,
  size_bytes         BIGINT,
  web_view_link      TEXT,
  owners             JSONB NOT NULL DEFAULT '[]'::jsonb,
  trashed            BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, file_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_gdrive_dedupe
  ON pai_raw_gdrive_files (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_gdrive_modified
  ON pai_raw_gdrive_files (user_id, modified_time DESC);

-- ── Slack (017) ──
CREATE TABLE IF NOT EXISTS pai_raw_slack_messages (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT,
  ts                 TEXT NOT NULL,
  thread_ts          TEXT,
  slack_user_id      TEXT,
  slack_user_name    TEXT,
  text               TEXT,
  permalink          TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, channel_id, ts)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_slack_dedupe
  ON pai_raw_slack_messages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_slack_occurred
  ON pai_raw_slack_messages (user_id, occurred_at DESC);

-- ── GitHub Issues (017) ──
CREATE TABLE IF NOT EXISTS pai_raw_github_issues (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  issue_id             TEXT NOT NULL,
  number               INTEGER,
  repo_full_name       TEXT,
  title                TEXT,
  body_preview         TEXT,
  state                TEXT,
  html_url             TEXT,
  is_pull_request      BOOLEAN NOT NULL DEFAULT FALSE,
  labels               JSONB NOT NULL DEFAULT '[]'::jsonb,
  assignees            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at_remote    TIMESTAMPTZ,
  updated_at_remote    TIMESTAMPTZ,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, issue_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_gh_issues_dedupe
  ON pai_raw_github_issues (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_gh_issues_repo_state
  ON pai_raw_github_issues (user_id, repo_full_name, state, updated_at_remote DESC);

-- ── YouTube Subscriptions (018) ──
CREATE TABLE IF NOT EXISTS pai_raw_youtube_subscriptions (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  subscription_id      TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  channel_title        TEXT,
  channel_description  TEXT,
  thumbnail_url        TEXT,
  subscribed_at        TIMESTAMPTZ,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, subscription_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_youtube_dedupe
  ON pai_raw_youtube_subscriptions (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_youtube_channel
  ON pai_raw_youtube_subscriptions (user_id, channel_id);

-- ── Calendly (018) ──
CREATE TABLE IF NOT EXISTS pai_raw_calendly_events (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  event_uri          TEXT NOT NULL,
  name               TEXT,
  status             TEXT,
  start_at           TIMESTAMPTZ,
  end_at             TIMESTAMPTZ,
  location_type      TEXT,
  location_value     TEXT,
  invitees           JSONB NOT NULL DEFAULT '[]'::jsonb,
  meeting_url        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, event_uri)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_calendly_dedupe
  ON pai_raw_calendly_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_calendly_start
  ON pai_raw_calendly_events (user_id, start_at DESC);

-- ── LinkedIn Profile (018) ──
CREATE TABLE IF NOT EXISTS pai_raw_linkedin_profile (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  linkedin_id        TEXT NOT NULL,
  first_name         TEXT,
  last_name          TEXT,
  localized_name     TEXT,
  headline           TEXT,
  vanity_name        TEXT,
  picture_url        TEXT,
  profile_url        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, linkedin_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_linkedin_profile_dedupe
  ON pai_raw_linkedin_profile (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Stripe Invoices (018) — amounts are INTEGER cents (Stripe wire format) ──
CREATE TABLE IF NOT EXISTS pai_raw_stripe_invoices (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  invoice_id           TEXT NOT NULL,
  number               TEXT,
  status               TEXT,
  amount_due           INTEGER,
  amount_paid          INTEGER,
  amount_remaining     INTEGER,
  currency             TEXT,
  customer_id          TEXT,
  customer_email       TEXT,
  customer_name        TEXT,
  collection_method    TEXT,
  created_at_remote    TIMESTAMPTZ,
  due_date             DATE,
  hosted_invoice_url   TEXT,
  invoice_pdf          TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, invoice_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pai_raw_stripe_inv_dedupe
  ON pai_raw_stripe_invoices (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pai_raw_stripe_inv_created
  ON pai_raw_stripe_invoices (user_id, created_at_remote DESC);
CREATE INDEX IF NOT EXISTS idx_pai_raw_stripe_inv_status
  ON pai_raw_stripe_invoices (user_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — same standard policy pair as 023 (user-scope + service_role fallback),
-- which CASCADE removed along with each dropped table. DROP-then-CREATE keeps it
-- idempotent on a fresh DB where 023 already installed identical policies.
-- service_role already exists (created idempotently in 023).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  recreated_tables TEXT[] := ARRAY[
    'pai_personal_signals',
    'pai_raw_device_health_observations',
    'pai_raw_gmail_messages',
    'pai_raw_gcal_events',
    'pai_raw_gdrive_files',
    'pai_raw_slack_messages',
    'pai_raw_github_issues',
    'pai_raw_youtube_subscriptions',
    'pai_raw_calendly_events',
    'pai_raw_linkedin_profile',
    'pai_raw_stripe_invoices'
  ];
BEGIN
  FOREACH t IN ARRAY recreated_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I_user_scope ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_user_scope ON %I
        FOR ALL TO PUBLIC
        USING (user_id = current_setting('app.user_id', true)::bigint)
        WITH CHECK (user_id = current_setting('app.user_id', true)::bigint)
    $f$, t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I_service_role ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY %I_service_role ON %I
        FOR ALL TO service_role
        USING (current_setting('app.user_id', true) IS NULL
            OR current_setting('app.user_id', true) = '')
        WITH CHECK (current_setting('app.user_id', true) IS NULL
                 OR current_setting('app.user_id', true) = '')
    $f$, t, t);
  END LOOP;
END$$;
