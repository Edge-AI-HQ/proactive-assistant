-- Raw connector data: personal toolkits.
-- Spotify / Strava / Todoist / YouTube / Twitter / Calendly / LinkedIn (profile +
-- orgs) / Figma / Zoom (user + marketplace_apps) / Dropbox (account + files) /
-- HubSpot / Stripe.

-- ── Spotify Recent Tracks (each row is a play event) ──
CREATE TABLE pai_raw_spotify_recent_tracks (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  track_id           TEXT NOT NULL,
  track_name         TEXT,
  artist_names       JSONB NOT NULL DEFAULT '[]'::jsonb,
  album_name         TEXT,
  duration_ms        INTEGER,
  popularity         INTEGER,
  track_url          TEXT,
  played_at          TIMESTAMPTZ NOT NULL,
  context_type       TEXT,
  context_uri        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, track_id, played_at)
);
CREATE UNIQUE INDEX idx_pai_raw_spotify_dedupe
  ON pai_raw_spotify_recent_tracks (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_spotify_played
  ON pai_raw_spotify_recent_tracks (user_id, played_at DESC);

-- ── Strava ──
CREATE TABLE pai_raw_strava_activities (
  user_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                     TEXT NOT NULL,
  activity_id            TEXT NOT NULL,
  name                   TEXT,
  activity_type          TEXT,
  distance_meters        REAL,
  moving_time_seconds    INTEGER,
  elapsed_time_seconds   INTEGER,
  elevation_gain_meters  REAL,
  start_date             TIMESTAMPTZ,
  timezone               TEXT,
  average_speed_mps      REAL,
  max_speed_mps          REAL,
  average_heartrate      INTEGER,
  max_heartrate          INTEGER,
  kudos_count            INTEGER,
  occurred_at            TIMESTAMPTZ NOT NULL,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key             TEXT,
  reference_count        INTEGER NOT NULL DEFAULT 0,
  last_referenced_at     TIMESTAMPTZ,
  referenced_by_runs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, activity_id)
);
CREATE UNIQUE INDEX idx_pai_raw_strava_dedupe
  ON pai_raw_strava_activities (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_strava_start
  ON pai_raw_strava_activities (user_id, start_date DESC);

-- ── Todoist ──
CREATE TABLE pai_raw_todoist_tasks (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  content            TEXT,
  description        TEXT,
  project_id         TEXT,
  parent_task_id     TEXT,
  priority           INTEGER,
  labels             JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at             TIMESTAMPTZ,
  is_completed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at_remote  TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, task_id)
);
CREATE UNIQUE INDEX idx_pai_raw_todoist_dedupe
  ON pai_raw_todoist_tasks (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_todoist_project
  ON pai_raw_todoist_tasks (user_id, project_id);

-- ── YouTube Subscriptions ──
CREATE TABLE pai_raw_youtube_subscriptions (
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
CREATE UNIQUE INDEX idx_pai_raw_youtube_dedupe
  ON pai_raw_youtube_subscriptions (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_youtube_channel
  ON pai_raw_youtube_subscriptions (user_id, channel_id);

-- ── Twitter Bookmarks ──
CREATE TABLE pai_raw_twitter_bookmarks (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  tweet_id           TEXT NOT NULL,
  author_username    TEXT,
  author_id          TEXT,
  text               TEXT,
  lang               TEXT,
  created_at_remote  TIMESTAMPTZ,
  url                TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, tweet_id)
);
CREATE UNIQUE INDEX idx_pai_raw_twitter_dedupe
  ON pai_raw_twitter_bookmarks (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_twitter_created
  ON pai_raw_twitter_bookmarks (user_id, created_at_remote DESC);

-- ── Calendly ──
CREATE TABLE pai_raw_calendly_events (
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
CREATE UNIQUE INDEX idx_pai_raw_calendly_dedupe
  ON pai_raw_calendly_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_calendly_start
  ON pai_raw_calendly_events (user_id, start_at DESC);

-- ── LinkedIn Profile (singleton per LinkedIn account) ──
CREATE TABLE pai_raw_linkedin_profile (
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
CREATE UNIQUE INDEX idx_pai_raw_linkedin_profile_dedupe
  ON pai_raw_linkedin_profile (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── LinkedIn Organizations ──
CREATE TABLE pai_raw_linkedin_organizations (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  org_urn            TEXT NOT NULL,
  org_id             TEXT,
  role               TEXT,
  role_state         TEXT,
  org_name           TEXT,
  org_url            TEXT,
  logo_url           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_pai_raw_linkedin_orgs_dedupe
  ON pai_raw_linkedin_organizations (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_linkedin_orgs_role
  ON pai_raw_linkedin_organizations (user_id, role);

-- ── Figma User (singleton) ──
CREATE TABLE pai_raw_figma_user (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  figma_id           TEXT NOT NULL,
  email              TEXT,
  handle             TEXT,
  img_url            TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, figma_id)
);
CREATE UNIQUE INDEX idx_pai_raw_figma_user_dedupe
  ON pai_raw_figma_user (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Zoom User (singleton) ──
CREATE TABLE pai_raw_zoom_user (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  zoom_id            TEXT NOT NULL,
  email              TEXT,
  first_name         TEXT,
  last_name          TEXT,
  display_name       TEXT,
  account_type       INTEGER,
  role_name          TEXT,
  department         TEXT,
  timezone           TEXT,
  location           TEXT,
  language           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, zoom_id)
);
CREATE UNIQUE INDEX idx_pai_raw_zoom_user_dedupe
  ON pai_raw_zoom_user (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Zoom Marketplace Apps ──
CREATE TABLE pai_raw_zoom_marketplace_apps (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  app_install_id     TEXT NOT NULL,
  app_id             TEXT,
  name               TEXT,
  publisher          TEXT,
  install_state      TEXT,
  app_type           TEXT,
  installed_at       TIMESTAMPTZ,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, app_install_id)
);
CREATE UNIQUE INDEX idx_pai_raw_zoom_apps_dedupe
  ON pai_raw_zoom_marketplace_apps (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Dropbox Account (singleton) ──
CREATE TABLE pai_raw_dropbox_account (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  email              TEXT,
  display_name       TEXT,
  given_name         TEXT,
  surname            TEXT,
  account_type       TEXT,
  country            TEXT,
  locale             TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, account_id)
);
CREATE UNIQUE INDEX idx_pai_raw_dropbox_account_dedupe
  ON pai_raw_dropbox_account (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── Dropbox Files ──
CREATE TABLE pai_raw_dropbox_files (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  file_id            TEXT NOT NULL,
  tag                TEXT,
  name               TEXT,
  path_lower         TEXT,
  path_display       TEXT,
  size_bytes         BIGINT,
  server_modified    TIMESTAMPTZ,
  client_modified    TIMESTAMPTZ,
  rev                TEXT,
  is_downloadable    BOOLEAN NOT NULL DEFAULT TRUE,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, file_id)
);
CREATE UNIQUE INDEX idx_pai_raw_dropbox_files_dedupe
  ON pai_raw_dropbox_files (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_dropbox_files_modified
  ON pai_raw_dropbox_files (user_id, server_modified DESC);

-- ── HubSpot Contacts ──
CREATE TABLE pai_raw_hubspot_contacts (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  contact_id           TEXT NOT NULL,
  email                TEXT,
  first_name           TEXT,
  last_name            TEXT,
  company              TEXT,
  jobtitle             TEXT,
  lifecycle_stage      TEXT,
  lead_status          TEXT,
  created_at_remote    TIMESTAMPTZ,
  modified_at_remote   TIMESTAMPTZ,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, contact_id)
);
CREATE UNIQUE INDEX idx_pai_raw_hubspot_dedupe
  ON pai_raw_hubspot_contacts (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_hubspot_modified
  ON pai_raw_hubspot_contacts (user_id, modified_at_remote DESC);

-- ── Stripe Invoices ──
-- Amounts are INTEGER cents (Stripe wire format) — keep as such, don't convert.
CREATE TABLE pai_raw_stripe_invoices (
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
CREATE UNIQUE INDEX idx_pai_raw_stripe_inv_dedupe
  ON pai_raw_stripe_invoices (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_stripe_inv_created
  ON pai_raw_stripe_invoices (user_id, created_at_remote DESC);
CREATE INDEX idx_pai_raw_stripe_inv_status
  ON pai_raw_stripe_invoices (user_id, status);
