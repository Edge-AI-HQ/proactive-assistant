-- Timeline Event Store: unified time-axis for all user events.
--
-- ADDITIVE layer dedicated to the proactive agent. `pai_personal_signals`
-- and the `pai_raw_*` tables are NOT replaced — they keep feeding the
-- existing main-chat / evolve / memory path unchanged. The timeline is a
-- second, parallel event store the proactive loop reads from.
--
-- It accepts events from two write paths:
--
--   1. Digital connectors (Gmail / GCal / Slack / GitHub / ...) — the
--      connector ingest sweep dual-writes here via rule-based `_tl_*`
--      projectors, in addition to the raw tables. No LLM in this path.
--      Status='pending' at write.
--
--   2. Ambient sensors (utterance / location / activity / sound / ...) —
--      written directly by /api/devices/ingest, bypassing the LLM for
--      sub-3s latency. Status='pending' at write.
--
-- Design notes:
--   * occurred_at is the position on the timeline (past OR future). Future
--     events (GCal start_at > now, predicted events) live in the same
--     table as past events.
--   * end_at NULL = point event; end_at NOT NULL = interval event. Lets
--     queries say "give me everything in the [t1, t2] window" without
--     UNION across two tables, and "what's currently happening" as
--     `occurred_at <= now() AND (end_at IS NULL OR end_at >= now())`.
--   * version + supersedes_id captures mutability of future events. When
--     a meeting is rescheduled, we INSERT a new row with version+1 and
--     supersedes_id pointing at the old row; old row's superseded_by_id
--     is set to close the chain. Both rows survive — agents can query
--     "intent history" via the chain.
--   * source_ref is a JSONB linking back to provenance — either a raw
--     table row or a device sensor event. Required so any event is
--     traceable.
--   * curation_status three-state machine:
--       'pending'      — ambient written, awaiting LLM importance score
--       'curated'      — LLM (or rule) has assigned importance, visible to agent
--       'filtered_out' — LLM judged the event not worth surfacing; kept
--                        for audit but excluded from default queries
--   * is_predicted flag separates ground-truth events (gcal future event,
--     directly known) from LLM-inferred future events (predicted by
--     analyzing emails/patterns).
--
-- Indexes optimized for the agent's primary query pattern:
--   "give me events in window [t1, t2], optionally filtered by source/type"

CREATE TABLE pai_timeline_events (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id                   TEXT NOT NULL,

  -- ── Time axis ──────────────────────────────────────────────────────
  -- Position on the timeline. Can be future (calendar events, predicted
  -- events) or past (emails, utterances, etc.). For interval events this
  -- is the start time.
  occurred_at          TIMESTAMPTZ NOT NULL,
  -- NULL for point events; for interval events (meetings, audio sessions,
  -- visits) marks the end. Always >= occurred_at when not NULL.
  end_at               TIMESTAMPTZ,

  -- ── Classification ─────────────────────────────────────────────────
  -- Concrete origin (one per recipe). Examples: 'gmail' | 'gcal' | 'slack' |
  -- 'github' | 'calendly' | 'gdrive' | 'stripe' | 'youtube' | 'linkedin' |
  -- 'ambient.utterance' | 'ambient.location' | 'ambient.activity' |
  -- 'ambient.sound' | 'ambient.visit' | 'ambient.audio_route' | 'health' |
  -- 'predicted.gmail' | 'predicted.gcal' | ...
  source               TEXT NOT NULL,
  -- Semantic category for cross-source grouping.
  -- Examples: 'communication' (email/slack/sms) | 'meeting' (gcal/calendly) |
  -- 'utterance' (transcribed speech) | 'movement' (visit/activity transitions) |
  -- 'state_change' (location/audio_route/focus changes) | 'consumption' (youtube/spotify) |
  -- 'transaction' (stripe/invoice) | 'commit' (github) | 'health' (workouts/sleep)
  event_type           TEXT NOT NULL,

  -- ── Content ────────────────────────────────────────────────────────
  -- One-line summary for the agent (<= 200 chars typical). Always present.
  title                TEXT NOT NULL,
  -- Optional long-form. Stored only when raw table doesn't preserve it
  -- (e.g. utterances — raw audio not kept). Email body / meeting description
  -- left NULL — agent can drill back to raw via source_ref if needed.
  body                 TEXT,
  -- Raw participants pulled from the source. Format: [{name, identifier?, role?}].
  -- No entity resolution at this layer — that's P2.
  participants         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Structured location when applicable. Format: {lat?, lng?, place_name?,
  -- address?, accuracy_m?}.
  location             JSONB,
  -- Source-specific extras. For utterance: {asr_confidence, language,
  -- speaker, vad_start_ms, vad_end_ms, audio_ref?}. For email:
  -- {label_ids, thread_id}. Schema is intentionally loose — what's
  -- normalized lives in the typed columns above.
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── Provenance (required) ──────────────────────────────────────────
  -- Always populated. Two shapes:
  --   digital: {raw_table: 'pai_raw_gmail_messages', raw_id: 'msg_...'}
  --   ambient: {device_id: '...', sensor: 'utterance', client_event_id: '...'}
  source_ref           JSONB NOT NULL,

  -- ── Quality / curation ─────────────────────────────────────────────
  -- LLM (or rule) judgment of "worth showing the agent". 0 = noise, 1 = critical.
  importance           REAL NOT NULL DEFAULT 0.5
                       CHECK (importance BETWEEN 0 AND 1),
  -- Our confidence in this row being accurate. Predicted events get < 1.
  -- Observed events default to 1.
  confidence           REAL NOT NULL DEFAULT 1.0
                       CHECK (confidence BETWEEN 0 AND 1),
  -- True for LLM-predicted future events. Lets the agent treat them with
  -- appropriate skepticism (or include/exclude them explicitly).
  is_predicted         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Curation state machine. See header comment.
  curation_status      TEXT NOT NULL DEFAULT 'curated'
                       CHECK (curation_status IN ('curated', 'pending', 'filtered_out')),
  -- Filled when the LLM judges this event not worth surfacing. Stored for
  -- audit / debugging — agent default query excludes filtered_out rows.
  filter_reason        TEXT,

  -- ── Versioning (future-event reschedule chain) ─────────────────────
  -- Bump on every replacement. Reads default to current version
  -- (superseded_by_id IS NULL).
  version              INT NOT NULL DEFAULT 1,
  -- This row replaced supersedes_id (a prior version of the same event).
  -- NULL on the first version.
  supersedes_id        TEXT,
  -- Set on the old row when a newer version arrives. Effectively
  -- a tombstone marker — old row stays for audit / intent history.
  superseded_by_id     TEXT,
  -- Snapshots of prior versions, chronological. Format:
  -- [{at: timestamptz, changed_fields: {key: {from, to}}, by: 'rule'|'llm'}]
  history              JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Dedupe ─────────────────────────────────────────────────────────
  -- Stable across re-ingestion of the same source event. Format examples:
  --   gmail:<message_id>
  --   gcal:<event_id>
  --   ambient:utterance:<device_id>:<client_event_id>
  --   predicted.gcal:<seed_event_id>:<predicted_at_iso>
  -- Unique per user when set (NULL allowed for one-off events).
  dedupe_key           TEXT,

  -- ── Timestamps ─────────────────────────────────────────────────────
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  curated_at           TIMESTAMPTZ,

  -- ── Reference tracking (sandbox runs consuming this row) ───────────
  -- Following the same triple as pai_raw_* and pai_memory: count + last +
  -- list of run_ids. Used by future archival logic to keep evidence rows
  -- that have been used by memory / cards.
  reference_count      INTEGER NOT NULL DEFAULT 0,
  last_referenced_at   TIMESTAMPTZ,
  referenced_by_runs   JSONB NOT NULL DEFAULT '[]'::jsonb,

  PRIMARY KEY (user_id, id),
  CONSTRAINT pai_timeline_events_end_at_after_occurred_at
    CHECK (end_at IS NULL OR end_at >= occurred_at)
);

-- Dedupe: per-user, partial (most events have a dedupe_key; one-off
-- inserts can leave it NULL without blocking the unique index).
CREATE UNIQUE INDEX idx_pai_timeline_dedupe
  ON pai_timeline_events (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Primary query: window scan by time. Used by every
-- client.timeline.query(...) call.
CREATE INDEX idx_pai_timeline_user_occurred
  ON pai_timeline_events (user_id, occurred_at DESC);

-- Source-filtered queries (e.g. "show me only ambient.utterance events").
CREATE INDEX idx_pai_timeline_user_source_occurred
  ON pai_timeline_events (user_id, source, occurred_at DESC);

-- Semantic-type filtering (e.g. "all meetings").
CREATE INDEX idx_pai_timeline_user_type_occurred
  ON pai_timeline_events (user_id, event_type, occurred_at DESC);

-- (Future-events queries are served by the primary
-- idx_pai_timeline_user_occurred index — a partial index gated on
-- `occurred_at > NOW()` would need NOW() to be IMMUTABLE, which it isn't.
-- Postgres optimizer prunes the range scan well enough that the dedicated
-- partial index isn't worth the maintenance.)

-- Curation backlog. Worker pulls oldest-pending first.
CREATE INDEX idx_pai_timeline_curation_pending
  ON pai_timeline_events (user_id, ingested_at)
  WHERE curation_status = 'pending';

-- Supersede-chain lookups (intent history for a specific event id).
CREATE INDEX idx_pai_timeline_supersedes
  ON pai_timeline_events (user_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- RLS — same pattern as 023_pai_rls.sql for every per-user pai_* table.
ALTER TABLE pai_timeline_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY pai_timeline_events_user_scope ON pai_timeline_events
  FOR ALL TO PUBLIC
  USING (user_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (user_id = current_setting('app.user_id', true)::bigint);
CREATE POLICY pai_timeline_events_service_role ON pai_timeline_events
  FOR ALL TO service_role
  USING (current_setting('app.user_id', true) IS NULL
      OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
           OR current_setting('app.user_id', true) = '');
