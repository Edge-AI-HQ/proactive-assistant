import { isNative } from "@/lib/platform";
import {
  DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
  MemoryTimelineStore,
  effectiveGenerationSource,
  timelineVisiblePayloadChanged,
  type AmbientActionBasket,
  type AmbientCandidateWindow,
  type AmbientRawEvent,
  type AmbientRawRef,
  type AmbientSourceType,
  type AmbientTimelineAction,
  type AmbientTimelineEvent,
  type AmbientTimelineStore,
  type AmbientWindowType,
  type AmbientSummarySchedulerState,
  type TimelineEventUpsertResult,
  type TimelineListOptions,
  type TimelineStoreStatus,
} from "@pin-ai/core";

// MemoryTimelineStore (platform-free) now lives in @pin-ai/core; re-exported so
// existing `@/services/ambient/...` importers keep working. The SQLite store
// below stays here because it binds to @capacitor-community/sqlite.
export { MemoryTimelineStore };

const DB_NAME = "pin_ambient_timeline";
const SUMMARY_SCHEDULER_STATE_KEY = "ambient_summary_scheduler_state_v1";
const TRANSCRIPT_LABEL_CLEANUP_KEY = "transcript_segment_label_cleanup_v1";

interface SqliteConnection {
  open(): Promise<void>;
  isDBOpen?(): Promise<{ result?: boolean }>;
  execute(sql: string): Promise<unknown>;
  run(sql: string, values?: unknown[]): Promise<{ changes?: { changes?: number } }>;
  query(sql: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
}

interface SqliteConnectionFactory {
  createConnection(
    dbName: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SqliteConnection>;
  retrieveConnection(dbName: string, readonly: boolean): Promise<SqliteConnection>;
  isConnection(dbName: string, readonly: boolean): Promise<{ result?: boolean }>;
}

interface SqliteModule {
  CapacitorSQLite?: unknown;
  SQLiteConnection?: new (sqlite: unknown) => SqliteConnectionFactory;
}

export class SqliteTimelineStore implements AmbientTimelineStore {
  readonly kind = "sqlite" as const;
  private conn: SqliteConnection | null = null;
  private ready = false;
  private lastError: string | null = null;

  async init(): Promise<void> {
    if (this.ready) return;
    try {
      const conn = await this.db();
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS ambient_raw_events (
          id TEXT PRIMARY KEY,
          local_user_id TEXT NOT NULL,
          device_id TEXT,
          source_type TEXT NOT NULL,
          event_type TEXT NOT NULL,
          source_version TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          ended_at TEXT,
          collected_at TEXT NOT NULL,
          timezone TEXT NOT NULL,
          local_date TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          compact_text TEXT NOT NULL,
          confidence REAL,
          sensitivity TEXT NOT NULL,
          permission_state TEXT,
          ttl_expires_at TEXT,
          content_hash TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          processing_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_ambient_raw_events_day_source
          ON ambient_raw_events (local_date, source_type, occurred_at);

        CREATE TABLE IF NOT EXISTS ambient_candidate_windows (
          id TEXT PRIMARY KEY,
          local_user_id TEXT NOT NULL,
          local_date TEXT NOT NULL,
          window_type TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          timezone TEXT NOT NULL,
          source_types_json TEXT NOT NULL,
          device_labels_json TEXT NOT NULL,
          raw_refs_json TEXT NOT NULL,
          observation_ids_json TEXT NOT NULL,
          compact_context TEXT NOT NULL,
          privacy_hint TEXT NOT NULL,
          confidence_hint REAL NOT NULL,
          salience_hint REAL NOT NULL,
          generation_policy TEXT NOT NULL,
          llm_input_hash TEXT,
          status TEXT NOT NULL,
          summary_status TEXT NOT NULL DEFAULT 'pending',
          summary_run_id TEXT,
          summary_processing_expires_at TEXT,
          summary_error_code TEXT,
          last_attempt_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error_code TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_ambient_candidate_windows_day_type
          ON ambient_candidate_windows (local_date, window_type, started_at);

        CREATE TABLE IF NOT EXISTS ambient_timeline_events (
          id TEXT PRIMARY KEY,
          local_user_id TEXT NOT NULL,
          local_date TEXT NOT NULL,
          timezone TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          ended_at TEXT,
          event_type TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          primary_source_label TEXT NOT NULL,
          device_labels_json TEXT NOT NULL,
          source_types_json TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          privacy TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_label TEXT NOT NULL,
          salience REAL NOT NULL,
          raw_refs_json TEXT NOT NULL,
          observation_ids_json TEXT NOT NULL,
          window_id TEXT,
          generation_method TEXT NOT NULL,
          generation_source TEXT,
          summary_run_id TEXT,
          source_window_ids_json TEXT,
          llm_model_id TEXT,
          llm_generated_at TEXT,
          llm_updated_at TEXT,
          idempotency_key TEXT,
          action_candidates_json TEXT,
          generation_status TEXT NOT NULL,
          dismissed_at TEXT,
          memory_candidate INTEGER NOT NULL,
          card_trigger_candidate INTEGER NOT NULL,
          triggered_card_id TEXT,
          triggered_card_title TEXT,
          schema_version TEXT NOT NULL,
          sync_status TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_ambient_timeline_events_day_visible
          ON ambient_timeline_events (local_date, generation_status, occurred_at);

        CREATE TABLE IF NOT EXISTS ambient_timeline_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      await this.migrateSchema(conn);
      this.ready = true;
      this.lastError = null;
    } catch (err) {
      this.lastError = describeError(err);
      throw err;
    }
  }

  status(): TimelineStoreStatus {
    return { mode: this.kind, ready: this.ready, lastError: this.lastError };
  }

  async upsertRawEvent(event: AmbientRawEvent): Promise<AmbientRawEvent> {
    await this.init();
    const conn = await this.db();
    await conn.run(
      `INSERT INTO ambient_raw_events (
         id, local_user_id, device_id, source_type, event_type, source_version,
         occurred_at, ended_at, collected_at, timezone, local_date,
         payload_json, compact_text, confidence, sensitivity, permission_state,
         ttl_expires_at, content_hash, dedupe_key, processing_status,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         device_id = excluded.device_id,
         source_version = excluded.source_version,
         ended_at = excluded.ended_at,
         collected_at = excluded.collected_at,
         payload_json = excluded.payload_json,
         compact_text = excluded.compact_text,
         confidence = excluded.confidence,
         sensitivity = excluded.sensitivity,
         permission_state = excluded.permission_state,
         ttl_expires_at = excluded.ttl_expires_at,
         content_hash = excluded.content_hash,
         processing_status = excluded.processing_status,
         updated_at = excluded.updated_at`,
      [
        event.id,
        event.localUserId,
        event.deviceId,
        event.sourceType,
        event.eventType,
        event.sourceVersion,
        event.occurredAt,
        event.endedAt ?? null,
        event.collectedAt,
        event.timezone,
        event.localDate,
        JSON.stringify(event.payload),
        event.compactText,
        event.confidence,
        event.sensitivity,
        event.permissionState,
        event.ttlExpiresAt,
        event.contentHash,
        event.dedupeKey,
        event.processingStatus,
        event.createdAt,
        event.updatedAt,
      ],
    );
    const rows = await conn.query(
      "SELECT * FROM ambient_raw_events WHERE dedupe_key = ? LIMIT 1",
      [event.dedupeKey],
    );
    const row = rows.values?.[0];
    return row ? rowToRawEvent(row) : event;
  }

  async listRawEvents(filter: {
    localDate?: string;
    sourceType?: AmbientSourceType;
    eventType?: string;
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<AmbientRawEvent[]> {
    await this.init();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.localDate) {
      clauses.push("local_date = ?");
      values.push(filter.localDate);
    }
    if (filter.sourceType) {
      clauses.push("source_type = ?");
      values.push(filter.sourceType);
    }
    if (filter.eventType) {
      clauses.push("event_type = ?");
      values.push(filter.eventType);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 500;
    const direction = filter.order === "desc" ? "DESC" : "ASC";
    const rows = await (await this.db()).query(
      `SELECT * FROM ambient_raw_events ${where}
       ORDER BY occurred_at ${direction} LIMIT ?`,
      [...values, limit],
    );
    return (rows.values ?? []).map(rowToRawEvent);
  }

  async getRawEventsByRefs(refs: AmbientRawRef[]): Promise<AmbientRawEvent[]> {
    if (refs.length === 0) return [];
    await this.init();
    const placeholders = refs.map(() => "?").join(",");
    const rows = await (await this.db()).query(
      `SELECT * FROM ambient_raw_events WHERE id IN (${placeholders}) ORDER BY occurred_at ASC`,
      refs.map((ref) => ref.id),
    );
    const sourceById = new Map(refs.map((ref) => [ref.id, ref.sourceType]));
    return (rows.values ?? [])
      .map(rowToRawEvent)
      .filter((raw) => sourceById.get(raw.id) === raw.sourceType);
  }

  async listRawEventsInRange(filter: {
    localDate: string;
    sourceType?: AmbientSourceType;
    eventType?: string;
    start: string;
    end: string;
    limit?: number;
  }): Promise<AmbientRawEvent[]> {
    await this.init();
    const clauses = [
      "local_date = ?",
      "occurred_at <= ?",
      "COALESCE(ended_at, occurred_at) >= ?",
    ];
    const values: unknown[] = [filter.localDate, filter.end, filter.start];
    if (filter.sourceType) {
      clauses.push("source_type = ?");
      values.push(filter.sourceType);
    }
    if (filter.eventType) {
      clauses.push("event_type = ?");
      values.push(filter.eventType);
    }
    const rows = await (await this.db()).query(
      `SELECT * FROM ambient_raw_events WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at ASC LIMIT ?`,
      [...values, filter.limit ?? 500],
    );
    return (rows.values ?? []).map(rowToRawEvent);
  }

  async upsertCandidateWindow(
    window: AmbientCandidateWindow,
  ): Promise<AmbientCandidateWindow> {
    await this.init();
    await (await this.db()).run(
      `INSERT INTO ambient_candidate_windows (
         id, local_user_id, local_date, window_type, started_at, ended_at,
         timezone, source_types_json, device_labels_json, raw_refs_json,
         observation_ids_json, compact_context, privacy_hint, confidence_hint,
         salience_hint, generation_policy, llm_input_hash, status,
         summary_status, summary_run_id, summary_processing_expires_at, summary_error_code, summary_error_message,
         last_attempt_at, attempt_count, last_error_code, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ended_at = excluded.ended_at,
         source_types_json = excluded.source_types_json,
         device_labels_json = excluded.device_labels_json,
         raw_refs_json = excluded.raw_refs_json,
         observation_ids_json = excluded.observation_ids_json,
         compact_context = excluded.compact_context,
         privacy_hint = excluded.privacy_hint,
         confidence_hint = excluded.confidence_hint,
         salience_hint = excluded.salience_hint,
         generation_policy = excluded.generation_policy,
         llm_input_hash = excluded.llm_input_hash,
         status = excluded.status,
         summary_status = excluded.summary_status,
         summary_run_id = excluded.summary_run_id,
         summary_processing_expires_at = excluded.summary_processing_expires_at,
         summary_error_code = excluded.summary_error_code,
         summary_error_message = excluded.summary_error_message,
         last_attempt_at = excluded.last_attempt_at,
         attempt_count = excluded.attempt_count,
         last_error_code = excluded.last_error_code,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [
        window.id,
        window.localUserId,
        window.localDate,
        window.windowType,
        window.startedAt,
        window.endedAt ?? null,
        window.timezone,
        JSON.stringify(window.sourceTypes),
        JSON.stringify(window.deviceLabels),
        JSON.stringify(window.rawRefs),
        JSON.stringify(window.observationIds),
        window.compactContext,
        window.privacyHint,
        window.confidenceHint,
        window.salienceHint,
        window.generationPolicy,
        window.llmInputHash,
        window.status,
        window.summaryStatus ?? (window.status === "generated" ? "summarized" : "pending"),
        window.summaryRunId ?? null,
        window.summaryProcessingExpiresAt ?? null,
        window.summaryErrorCode ?? null,
        window.summaryErrorMessage ?? null,
        window.lastAttemptAt,
        window.attemptCount,
        window.lastErrorCode,
        window.expiresAt,
        window.createdAt,
        window.updatedAt,
      ],
    );
    return window;
  }

  async listCandidateWindows(filter: {
    localDate?: string;
    windowType?: AmbientWindowType;
    status?: AmbientCandidateWindow["status"];
    summaryStatus?: NonNullable<AmbientCandidateWindow["summaryStatus"]>;
    limit?: number;
  }): Promise<AmbientCandidateWindow[]> {
    await this.init();
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.localDate) {
      clauses.push("local_date = ?");
      values.push(filter.localDate);
    }
    if (filter.windowType) {
      clauses.push("window_type = ?");
      values.push(filter.windowType);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    if (filter.summaryStatus) {
      clauses.push("summary_status = ?");
      values.push(filter.summaryStatus);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await (await this.db()).query(
      `SELECT * FROM ambient_candidate_windows ${where}
       ORDER BY started_at ASC LIMIT ?`,
      [...values, filter.limit ?? 500],
    );
    return (rows.values ?? []).map(rowToWindow);
  }

  async upsertTimelineEvent(
    event: AmbientTimelineEvent,
  ): Promise<TimelineEventUpsertResult> {
    await this.init();
    const conn = await this.db();
    const existingRows = await conn.query(
      "SELECT * FROM ambient_timeline_events WHERE id = ? LIMIT 1",
      [event.id],
    );
    const existing = existingRows.values?.[0]
      ? rowToTimelineEvent(existingRows.values[0])
      : null;
    if (existing?.generationStatus === "hidden") {
      return { event: existing, shouldSync: false };
    }
    const createdAt = existing?.createdAt ?? event.createdAt;
    const visibleChanged = existing ? timelineVisiblePayloadChanged(existing, event) : false;
    const nextSyncStatus = existing?.syncStatus === "synced" && visibleChanged
      ? "pending"
      : event.syncStatus;
    await conn.run(
      `INSERT INTO ambient_timeline_events (
         id, local_user_id, local_date, timezone, occurred_at, ended_at,
         event_type, title, summary, primary_source_label, device_labels_json,
         source_types_json, tags_json, privacy, confidence, confidence_label,
         salience, raw_refs_json, observation_ids_json, window_id,
         generation_method, generation_source, summary_run_id, source_window_ids_json,
         llm_model_id, llm_generated_at, llm_updated_at, idempotency_key,
         action_candidates_json,
         generation_status, dismissed_at, memory_candidate,
         card_trigger_candidate, triggered_card_id, triggered_card_title,
         schema_version, sync_status, dedupe_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ended_at = excluded.ended_at,
         title = excluded.title,
         summary = excluded.summary,
         primary_source_label = excluded.primary_source_label,
         device_labels_json = excluded.device_labels_json,
         source_types_json = excluded.source_types_json,
         tags_json = excluded.tags_json,
         privacy = excluded.privacy,
         confidence = excluded.confidence,
         confidence_label = excluded.confidence_label,
         salience = excluded.salience,
         raw_refs_json = excluded.raw_refs_json,
         observation_ids_json = excluded.observation_ids_json,
         window_id = excluded.window_id,
         generation_method = excluded.generation_method,
         generation_source = excluded.generation_source,
         summary_run_id = excluded.summary_run_id,
         source_window_ids_json = excluded.source_window_ids_json,
         llm_model_id = excluded.llm_model_id,
         llm_generated_at = excluded.llm_generated_at,
         llm_updated_at = excluded.llm_updated_at,
         idempotency_key = excluded.idempotency_key,
         action_candidates_json = excluded.action_candidates_json,
         generation_status = excluded.generation_status,
         memory_candidate = excluded.memory_candidate,
         card_trigger_candidate = excluded.card_trigger_candidate,
         triggered_card_id = excluded.triggered_card_id,
         triggered_card_title = excluded.triggered_card_title,
         schema_version = excluded.schema_version,
         sync_status = excluded.sync_status,
         updated_at = excluded.updated_at`,
      [
        event.id,
        event.localUserId,
        event.localDate,
        event.timezone,
        event.occurredAt,
        event.endedAt ?? null,
        event.eventType,
        event.title,
        event.summary,
        event.primarySourceLabel,
        JSON.stringify(event.deviceLabels),
        JSON.stringify(event.sourceTypes),
        JSON.stringify(event.tags),
        event.privacy,
        event.confidence,
        event.confidenceLabel,
        event.salience,
        JSON.stringify(event.rawRefs),
        JSON.stringify(event.observationIds),
        event.windowId ?? null,
        event.generationMethod,
        event.generationSource ?? (event.generationMethod === "local_llm" || event.generationMethod === "cloud_llm" ? "llm_summary" : "rule_based"),
        event.summaryRunId ?? null,
        JSON.stringify(event.sourceWindowIds ?? []),
        event.llmModelId ?? null,
        event.llmGeneratedAt ?? null,
        event.llmUpdatedAt ?? null,
        event.idempotencyKey ?? null,
        serializeActionCandidates(event.actionCandidates),
        event.generationStatus,
        event.dismissedAt ?? null,
        event.memoryCandidate ? 1 : 0,
        event.cardTriggerCandidate ? 1 : 0,
        event.triggeredCardId ?? null,
        event.triggeredCardTitle ?? null,
        event.schemaVersion,
        nextSyncStatus,
        event.dedupeKey,
        createdAt,
        event.updatedAt,
      ],
    );
    const rows = await conn.query(
      "SELECT * FROM ambient_timeline_events WHERE id = ? LIMIT 1",
      [event.id],
    );
    const next = rows.values?.[0] ? rowToTimelineEvent(rows.values[0]) : event;
    return {
      event: next,
      shouldSync:
        next.generationStatus === "visible" && (existing?.syncStatus !== "synced" || visibleChanged),
    };
  }

  async listTimelineEvents(
    localDate: string,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    await this.init();
    return this.queryTimelineEvents(localDate, options);
  }

  async listTimelineEventsByGenerationSource(
    localDate: string,
    generationSource: NonNullable<AmbientTimelineEvent["generationSource"]>,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    await this.init();
    const rows = await this.queryTimelineEvents(localDate, options);
    return rows.filter((row) => effectiveGenerationSource(row) === generationSource);
  }

  private async queryTimelineEvents(
    localDate: string,
    options: TimelineListOptions = {},
  ): Promise<AmbientTimelineEvent[]> {
    const clauses = ["local_date = ?"];
    const values: unknown[] = [localDate];
    if (options.visibleOnly) {
      clauses.push("generation_status = 'visible'");
    }
    const rows = await (await this.db()).query(
      `SELECT * FROM ambient_timeline_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at ASC, created_at ASC
       LIMIT ?`,
      [...values, options.limit ?? 100],
    );
    return (rows.values ?? []).map(rowToTimelineEvent);
  }

  async dismissTimelineEvent(id: string, at = new Date().toISOString()): Promise<void> {
    await this.init();
    await (await this.db()).run(
      `UPDATE ambient_timeline_events
       SET generation_status = 'hidden', dismissed_at = ?, updated_at = ?
       WHERE id = ?`,
      [at, at, id],
    );
  }

  async markTimelineEventsSynced(ids: string[], at = new Date().toISOString()): Promise<void> {
    if (ids.length === 0) return;
    await this.init();
    const placeholders = ids.map(() => "?").join(",");
    await (await this.db()).run(
      `UPDATE ambient_timeline_events
       SET sync_status = 'synced', updated_at = ?
       WHERE id IN (${placeholders})`,
      [at, ...ids],
    );
  }

  async getSummarySchedulerState(): Promise<AmbientSummarySchedulerState> {
    await this.init();
    const rows = await (await this.db()).query(
      "SELECT value FROM ambient_timeline_meta WHERE key = ? LIMIT 1",
      [SUMMARY_SCHEDULER_STATE_KEY],
    );
    return parseSummarySchedulerState(rows.values?.[0]?.value);
  }

  async setSummarySchedulerState(state: AmbientSummarySchedulerState): Promise<void> {
    await this.init();
    await (await this.db()).run(
      "INSERT OR REPLACE INTO ambient_timeline_meta (key, value) VALUES (?, ?)",
      [SUMMARY_SCHEDULER_STATE_KEY, JSON.stringify(state)],
    );
  }

  private async db(): Promise<SqliteConnection> {
    if (this.conn) return this.conn;
    const mod = await import("@capacitor-community/sqlite") as SqliteModule;
    if (!mod.CapacitorSQLite || !mod.SQLiteConnection) {
      throw new Error("@capacitor-community/sqlite plugin not available");
    }
    const sqlite = new mod.SQLiteConnection(mod.CapacitorSQLite);
    const probe = await sqlite
      .isConnection(DB_NAME, false)
      .catch(() => ({ result: false }));
    const conn = probe.result
      ? await sqlite.retrieveConnection(DB_NAME, false)
      : await createOrRetrieveSqliteConnection(sqlite);
    const open = await conn.isDBOpen?.().catch(() => ({ result: false }));
    if (open?.result !== true) await conn.open();
    this.conn = conn;
    return conn;
  }

  private async migrateSchema(conn: SqliteConnection): Promise<void> {
    await ensureColumns(conn, "ambient_candidate_windows", [
      { name: "last_attempt_at", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN last_attempt_at TEXT" },
      { name: "attempt_count", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0" },
      { name: "last_error_code", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN last_error_code TEXT" },
      { name: "summary_status", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'pending'" },
      { name: "summary_run_id", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_run_id TEXT" },
      { name: "summary_processing_expires_at", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_processing_expires_at TEXT" },
      { name: "summary_error_code", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_error_code TEXT" },
      { name: "summary_error_message", sql: "ALTER TABLE ambient_candidate_windows ADD COLUMN summary_error_message TEXT" },
    ]);
    await ensureColumns(conn, "ambient_timeline_events", [
      { name: "generation_source", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN generation_source TEXT" },
      { name: "summary_run_id", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN summary_run_id TEXT" },
      { name: "source_window_ids_json", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN source_window_ids_json TEXT" },
      { name: "llm_model_id", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN llm_model_id TEXT" },
      { name: "llm_generated_at", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN llm_generated_at TEXT" },
      { name: "llm_updated_at", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN llm_updated_at TEXT" },
      { name: "idempotency_key", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN idempotency_key TEXT" },
      { name: "action_candidates_json", sql: "ALTER TABLE ambient_timeline_events ADD COLUMN action_candidates_json TEXT" },
    ]);
    await cleanTranscriptSegmentLabels(conn);
  }
}

async function createOrRetrieveSqliteConnection(
  sqlite: SqliteConnectionFactory,
): Promise<SqliteConnection> {
  try {
    return await sqlite.createConnection(DB_NAME, false, "no-encryption", 1, false);
  } catch (err) {
    if (!isConnectionAlreadyExistsError(err)) throw err;
    return sqlite.retrieveConnection(DB_NAME, false);
  }
}

function isConnectionAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("already exists");
}

async function cleanTranscriptSegmentLabels(conn: SqliteConnection): Promise<void> {
  const marker = await conn.query(
    "SELECT value FROM ambient_timeline_meta WHERE key = ?",
    [TRANSCRIPT_LABEL_CLEANUP_KEY],
  );
  if (marker.values?.[0]?.value === "done") return;

  await conn.run(
    `UPDATE ambient_raw_events
     SET compact_text = trim(
           replace(
             replace(compact_text, 'Transcript segment: ', ''),
             'Transcript segment:',
             ''
           )
         ),
         content_hash = ''
     WHERE source_type = 'transcript'`,
  );

  await conn.run(
    `UPDATE ambient_candidate_windows
     SET compact_context = trim(
           replace(
             replace(compact_context, 'Transcript segment: ', ''),
             'Transcript segment:',
             ''
           )
         ),
         llm_input_hash = NULL
     WHERE window_type = 'transcript_session'`,
  );

  await conn.run(
    "INSERT OR REPLACE INTO ambient_timeline_meta (key, value) VALUES (?, ?)",
    [TRANSCRIPT_LABEL_CLEANUP_KEY, "done"],
  );
}

export function createDefaultTimelineStore(): AmbientTimelineStore {
  return isNative ? new SqliteTimelineStore() : new MemoryTimelineStore();
}

let singleton: AmbientTimelineStore | null = null;

export function getAmbientTimelineStore(): AmbientTimelineStore {
  if (!singleton) singleton = createDefaultTimelineStore();
  return singleton;
}

function rowToRawEvent(row: Record<string, unknown>): AmbientRawEvent {
  return {
    id: text(row.id),
    localUserId: text(row.local_user_id),
    deviceId: nullableText(row.device_id),
    sourceType: text(row.source_type) as AmbientSourceType,
    eventType: text(row.event_type),
    sourceVersion: text(row.source_version),
    occurredAt: text(row.occurred_at),
    ...(nullableText(row.ended_at) ? { endedAt: text(row.ended_at) } : {}),
    collectedAt: text(row.collected_at),
    timezone: text(row.timezone),
    localDate: text(row.local_date),
    payload: parseRecord(row.payload_json),
    compactText: text(row.compact_text),
    confidence: nullableNumber(row.confidence),
    sensitivity: text(row.sensitivity) as AmbientRawEvent["sensitivity"],
    permissionState: nullableText(row.permission_state),
    ttlExpiresAt: nullableText(row.ttl_expires_at),
    contentHash: text(row.content_hash),
    dedupeKey: text(row.dedupe_key),
    processingStatus: text(row.processing_status) as AmbientRawEvent["processingStatus"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function rowToWindow(row: Record<string, unknown>): AmbientCandidateWindow {
  return {
    id: text(row.id),
    localUserId: text(row.local_user_id),
    localDate: text(row.local_date),
    windowType: text(row.window_type) as AmbientCandidateWindow["windowType"],
    startedAt: text(row.started_at),
    ...(nullableText(row.ended_at) ? { endedAt: text(row.ended_at) } : {}),
    timezone: text(row.timezone),
    sourceTypes: parseStringArray(row.source_types_json) as AmbientSourceType[],
    deviceLabels: parseStringArray(row.device_labels_json),
    rawRefs: parseRawRefs(row.raw_refs_json),
    observationIds: parseStringArray(row.observation_ids_json),
    compactContext: text(row.compact_context),
    privacyHint: text(row.privacy_hint) as AmbientCandidateWindow["privacyHint"],
    confidenceHint: numberValue(row.confidence_hint),
    salienceHint: numberValue(row.salience_hint),
    generationPolicy: text(row.generation_policy) as AmbientCandidateWindow["generationPolicy"],
    llmInputHash: nullableText(row.llm_input_hash),
    status: text(row.status) as AmbientCandidateWindow["status"],
    summaryStatus: (nullableText(row.summary_status) ?? (text(row.status) === "generated" ? "summarized" : "pending")) as AmbientCandidateWindow["summaryStatus"],
    summaryRunId: nullableText(row.summary_run_id),
    summaryProcessingExpiresAt: nullableText(row.summary_processing_expires_at),
    summaryErrorCode: nullableText(row.summary_error_code),
    summaryErrorMessage: nullableText(row.summary_error_message),
    lastAttemptAt: nullableText(row.last_attempt_at),
    attemptCount: numberValue(row.attempt_count),
    lastErrorCode: nullableText(row.last_error_code),
    expiresAt: nullableText(row.expires_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function rowToTimelineEvent(row: Record<string, unknown>): AmbientTimelineEvent {
  return {
    id: text(row.id),
    localUserId: text(row.local_user_id),
    localDate: text(row.local_date),
    timezone: text(row.timezone),
    occurredAt: text(row.occurred_at),
    ...(nullableText(row.ended_at) ? { endedAt: text(row.ended_at) } : {}),
    eventType: text(row.event_type) as AmbientTimelineEvent["eventType"],
    title: text(row.title),
    summary: text(row.summary),
    primarySourceLabel: text(row.primary_source_label),
    deviceLabels: parseStringArray(row.device_labels_json),
    sourceTypes: parseStringArray(row.source_types_json) as AmbientSourceType[],
    tags: parseStringArray(row.tags_json),
    privacy: text(row.privacy) as AmbientTimelineEvent["privacy"],
    confidence: numberValue(row.confidence),
    confidenceLabel: text(row.confidence_label) as AmbientTimelineEvent["confidenceLabel"],
    salience: numberValue(row.salience),
    rawRefs: parseRawRefs(row.raw_refs_json),
    observationIds: parseStringArray(row.observation_ids_json),
    ...(nullableText(row.window_id) ? { windowId: text(row.window_id) } : {}),
    generationMethod: text(row.generation_method) as AmbientTimelineEvent["generationMethod"],
    generationSource: (nullableText(row.generation_source) as AmbientTimelineEvent["generationSource"] | null) ?? undefined,
    ...(nullableText(row.summary_run_id) ? { summaryRunId: text(row.summary_run_id) } : {}),
    sourceWindowIds: parseStringArray(row.source_window_ids_json),
    ...(nullableText(row.llm_model_id) ? { llmModelId: text(row.llm_model_id) } : {}),
    ...(nullableText(row.llm_generated_at) ? { llmGeneratedAt: text(row.llm_generated_at) } : {}),
    ...(nullableText(row.llm_updated_at) ? { llmUpdatedAt: text(row.llm_updated_at) } : {}),
    ...(nullableText(row.idempotency_key) ? { idempotencyKey: text(row.idempotency_key) } : {}),
    ...actionCandidatesFromRow(row.action_candidates_json),
    generationStatus: text(row.generation_status) as AmbientTimelineEvent["generationStatus"],
    ...(nullableText(row.dismissed_at) ? { dismissedAt: text(row.dismissed_at) } : {}),
    memoryCandidate: numberValue(row.memory_candidate) === 1,
    cardTriggerCandidate: numberValue(row.card_trigger_candidate) === 1,
    ...(nullableText(row.triggered_card_id) ? { triggeredCardId: text(row.triggered_card_id) } : {}),
    ...(nullableText(row.triggered_card_title) ? { triggeredCardTitle: text(row.triggered_card_title) } : {}),
    schemaVersion: text(row.schema_version) as AmbientTimelineEvent["schemaVersion"],
    syncStatus: text(row.sync_status) as AmbientTimelineEvent["syncStatus"],
    dedupeKey: text(row.dedupe_key),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function serializeActionCandidates(
  actions: AmbientTimelineAction[] | undefined,
): string | null {
  if (!actions || actions.length === 0) return null;
  return JSON.stringify(actions.map((action) => ({
    label: action.label,
    goal: action.goal,
    ...(action.goalBasket ? { goalBasket: action.goalBasket } : {}),
  })));
}

function actionCandidatesFromRow(
  value: unknown,
): { actionCandidates: AmbientTimelineAction[] } | Record<string, never> {
  const parsed = parseActionCandidates(value);
  return parsed.length > 0 ? { actionCandidates: parsed } : {};
}

function parseActionCandidates(value: unknown): AmbientTimelineAction[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: AmbientTimelineAction[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const label = typeof row.label === "string" ? row.label.trim() : "";
      const goal = typeof row.goal === "string" ? row.goal.trim() : "";
      if (!label || !goal) continue;
      const basket = typeof row.goalBasket === "string" ? row.goalBasket : "";
      out.push({
        label,
        goal,
        ...(isAmbientActionBasket(basket) ? { goalBasket: basket } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

const ACTION_BASKET_VALUES: ReadonlySet<AmbientActionBasket> = new Set([
  "work",
  "health",
  "family",
  "wealth",
  "growth",
  "life",
]);

function isAmbientActionBasket(value: string): value is AmbientActionBasket {
  return ACTION_BASKET_VALUES.has(value as AmbientActionBasket);
}

function parseRawRefs(value: unknown): AmbientTimelineEvent["rawRefs"] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.sourceType !== "string" || typeof row.id !== "string") {
        return [];
      }
      return [{ sourceType: row.sourceType as AmbientSourceType, id: row.id }];
    });
  } catch {
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function ensureColumns(
  conn: SqliteConnection,
  table: string,
  columns: Array<{ name: string; sql: string }>,
): Promise<void> {
  const rows = await conn.query(`PRAGMA table_info(${table})`);
  const existing = new Set((rows.values ?? [])
    .map((row) => typeof row.name === "string" ? row.name : null)
    .filter((name): name is string => name !== null));

  for (const column of columns) {
    if (existing.has(column.name)) continue;
    await conn.run(column.sql);
  }
}

function parseSummarySchedulerState(value: unknown): AmbientSummarySchedulerState {
  if (typeof value !== "string" || value.length === 0) {
    return DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE;
    }
    const row = parsed as Partial<AmbientSummarySchedulerState>;
    return {
      ...DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE,
      ...row,
      retryCount: typeof row.retryCount === "number" ? row.retryCount : 0,
    };
  } catch {
    return DEFAULT_AMBIENT_SUMMARY_SCHEDULER_STATE;
  }
}
