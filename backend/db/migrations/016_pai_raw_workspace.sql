-- Raw connector data: workspace toolkits.
-- Tables: gmail / gcal / gdrive / gdocs / gsheets / outlook.
-- 1:1 from raw-db.ts. Reference triple kept (used by agent-run consumption tracking).

-- ── Gmail ──
CREATE TABLE pai_raw_gmail_messages (
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
CREATE UNIQUE INDEX idx_pai_raw_gmail_dedupe
  ON pai_raw_gmail_messages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gmail_thread ON pai_raw_gmail_messages (user_id, thread_id);
CREATE INDEX idx_pai_raw_gmail_occurred
  ON pai_raw_gmail_messages (user_id, occurred_at DESC);

-- ── Google Calendar ──
CREATE TABLE pai_raw_gcal_events (
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
CREATE UNIQUE INDEX idx_pai_raw_gcal_dedupe
  ON pai_raw_gcal_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gcal_start
  ON pai_raw_gcal_events (user_id, start_at DESC);

-- ── Google Drive (generic files) ──
CREATE TABLE pai_raw_gdrive_files (
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
CREATE UNIQUE INDEX idx_pai_raw_gdrive_dedupe
  ON pai_raw_gdrive_files (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gdrive_modified
  ON pai_raw_gdrive_files (user_id, modified_time DESC);

-- ── Google Docs ──
CREATE TABLE pai_raw_gdocs_documents (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  document_id          TEXT NOT NULL,
  name                 TEXT,
  modified_time        TIMESTAMPTZ,
  created_time         TIMESTAMPTZ,
  web_view_link        TEXT,
  owners               JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_modifying_user  TEXT,
  starred              BOOLEAN NOT NULL DEFAULT FALSE,
  trashed              BOOLEAN NOT NULL DEFAULT FALSE,
  shared               BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, document_id)
);
CREATE UNIQUE INDEX idx_pai_raw_gdocs_dedupe
  ON pai_raw_gdocs_documents (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gdocs_modified
  ON pai_raw_gdocs_documents (user_id, modified_time DESC);

-- ── Google Sheets ──
CREATE TABLE pai_raw_gsheets_spreadsheets (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,
  spreadsheet_id       TEXT NOT NULL,
  name                 TEXT,
  modified_time        TIMESTAMPTZ,
  created_time         TIMESTAMPTZ,
  web_view_link        TEXT,
  owners               JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_modifying_user  TEXT,
  starred              BOOLEAN NOT NULL DEFAULT FALSE,
  trashed              BOOLEAN NOT NULL DEFAULT FALSE,
  shared               BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at          TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key           TEXT,
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, spreadsheet_id)
);
CREATE UNIQUE INDEX idx_pai_raw_gsheets_dedupe
  ON pai_raw_gsheets_spreadsheets (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_gsheets_modified
  ON pai_raw_gsheets_spreadsheets (user_id, modified_time DESC);

-- ── Outlook ──
CREATE TABLE pai_raw_outlook_messages (
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                 TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  conversation_id    TEXT,
  from_addr          TEXT,
  to_addrs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addrs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject            TEXT,
  body_preview       TEXT,
  received_at        TIMESTAMPTZ,
  importance         TEXT,
  has_attachments    BOOLEAN NOT NULL DEFAULT FALSE,
  web_link           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key         TEXT,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  last_referenced_at TIMESTAMPTZ,
  referenced_by_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, message_id)
);
CREATE UNIQUE INDEX idx_pai_raw_outlook_dedupe
  ON pai_raw_outlook_messages (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_pai_raw_outlook_received
  ON pai_raw_outlook_messages (user_id, received_at DESC);
CREATE INDEX idx_pai_raw_outlook_conv
  ON pai_raw_outlook_messages (user_id, conversation_id);
