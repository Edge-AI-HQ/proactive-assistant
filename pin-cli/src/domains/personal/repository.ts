import type { SqliteDatabase } from "../../db/sqlite_adapter.js";

export interface PersonalConnectedSourceRecord {
  id: string;
  userId: string;
  provider: string;
  toolkit: string;
  connectedAccountId: string;
  accountLabel: string | null;
  status: string;
  syncEnabled: boolean;
  scopesJson: string | null;
  authMetadataJson: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalSyncStateRecord {
  sourceId: string;
  userId: string;
  syncStrategy: string;
  cursorJson: string | null;
  lastSuccessAt: string | null;
  lastWatermarkAt: string | null;
  lastBackfillAt: string | null;
  updatedAt: string;
}

export interface PersonalSyncRunRecord {
  id: string;
  sourceId: string | null;
  userId: string | null;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  cursorBeforeJson: string | null;
  cursorAfterJson: string | null;
  fetchedCount: number;
  upsertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PersonalContextItemRecord {
  id: string;
  sourceId: string;
  userId: string;
  toolkit: string;
  itemType: string;
  externalId: string;
  externalParentId: string | null;
  title: string | null;
  contentText: string | null;
  url: string | null;
  occurredAt: string | null;
  syncedAt: string;
  contentHash: string | null;
  attributesJson: string;
  rawJson: string;
  searchText: string;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalSearchResultRecord {
  id: string;
  sourceId: string;
  userId: string;
  toolkit: string;
  itemType: string;
  occurredAt: string | null;
  title: string | null;
  url: string | null;
  snippet: string | null;
  score: number | null;
  attributesJson: string;
}

export interface UpsertPersonalConnectedSourceInput {
  id: string;
  userId: string;
  provider: string;
  toolkit: string;
  connectedAccountId: string;
  accountLabel?: string | null;
  status: string;
  syncEnabled: boolean;
  scopesJson?: string | null;
  authMetadataJson?: string | null;
  lastSeenAt?: string | null;
}

export interface UpsertPersonalSyncStateInput {
  sourceId: string;
  userId: string;
  syncStrategy: string;
  cursorJson?: string | null;
  lastSuccessAt?: string | null;
  lastWatermarkAt?: string | null;
  lastBackfillAt?: string | null;
}

export interface UpsertPersonalContextItemInput {
  id: string;
  sourceId: string;
  userId: string;
  toolkit: string;
  itemType: string;
  externalId: string;
  externalParentId?: string | null;
  title?: string | null;
  contentText?: string | null;
  url?: string | null;
  occurredAt?: string | null;
  syncedAt: string;
  contentHash?: string | null;
  attributesJson?: string | null;
  rawJson: string;
  searchText?: string | null;
  isDeleted?: boolean;
}

export interface PersonalSyncRunInput {
  id: string;
  sourceId?: string | null;
  userId?: string | null;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  cursorBeforeJson?: string | null;
  cursorAfterJson?: string | null;
  fetchedCount?: number;
  upsertedCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface PersonalItemQueryInput {
  from?: string | null;
  to?: string | null;
  sourceIds?: string[];
  toolkits?: string[];
  itemTypes?: string[];
  facet?: { key: string; value: string } | null;
  limit?: number;
}

interface PersonalConnectedSourceRow {
  id: string;
  user_id: string;
  provider: string;
  toolkit: string;
  connected_account_id: string;
  account_label: string | null;
  status: string;
  sync_enabled: number;
  scopes_json: string | null;
  auth_metadata_json: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonalSyncStateRow {
  source_id: string;
  user_id: string;
  sync_strategy: string;
  cursor_json: string | null;
  last_success_at: string | null;
  last_watermark_at: string | null;
  last_backfill_at: string | null;
  updated_at: string;
}

interface PersonalContextItemRow {
  id: string;
  source_id: string;
  user_id: string;
  toolkit: string;
  item_type: string;
  external_id: string;
  external_parent_id: string | null;
  title: string | null;
  content_text: string | null;
  url: string | null;
  occurred_at: string | null;
  synced_at: string;
  content_hash: string | null;
  attributes_json: string;
  raw_json: string;
  search_text: string;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

interface PersonalSyncRunRow {
  id: string;
  source_id: string | null;
  user_id: string | null;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  cursor_before_json: string | null;
  cursor_after_json: string | null;
  fetched_count: number;
  upserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_code: string | null;
  error_message: string | null;
}

interface PersonalSearchRow {
  id: string;
  source_id: string;
  user_id: string;
  toolkit: string;
  item_type: string;
  occurred_at: string | null;
  title: string | null;
  url: string | null;
  snippet: string | null;
  score: number | null;
  attributes_json: string;
}

export class PersonalRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  private ensureColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    const rows = this.database.all<{ name: string }>(`pragma table_info(${table})`);
    const columnNames = new Set(rows.map((row) => row.name));
    if (!columnNames.has(column)) {
      this.database.exec(`alter table ${table} add column ${definition}`);
    }
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    this.database.exec(`
      create table if not exists pf_connected_sources (
        id text primary key not null,
        user_id text not null default '',
        provider text not null,
        toolkit text not null,
        connected_account_id text not null,
        account_label text,
        status text not null default 'discovered',
        sync_enabled integer not null default 1,
        scopes_json text,
        auth_metadata_json text,
        last_seen_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists pf_context_items (
        id text primary key not null,
        source_id text not null,
        user_id text not null default '',
        toolkit text not null,
        item_type text not null,
        external_id text not null,
        external_parent_id text,
        title text,
        content_text text,
        url text,
        occurred_at text,
        synced_at text not null,
        content_hash text,
        attributes_json text not null default '{}',
        raw_json text not null,
        search_text text not null default '',
        is_deleted integer not null default 0,
        created_at text not null,
        updated_at text not null,
        foreign key (source_id) references pf_connected_sources(id)
      );

      create unique index if not exists idx_pf_context_items_external
        on pf_context_items(source_id, item_type, external_id);
      create index if not exists idx_pf_context_items_user_occurred_at
        on pf_context_items(user_id, occurred_at);
      create index if not exists idx_pf_context_items_occurred_at
        on pf_context_items(occurred_at);
      create index if not exists idx_pf_context_items_toolkit_occurred_at
        on pf_context_items(toolkit, occurred_at);
      create index if not exists idx_pf_context_items_item_type_occurred_at
        on pf_context_items(item_type, occurred_at);

      create table if not exists pf_sync_runs (
        id text primary key not null,
        source_id text,
        user_id text,
        mode text not null,
        status text not null,
        started_at text not null,
        finished_at text,
        cursor_before_json text,
        cursor_after_json text,
        fetched_count integer not null default 0,
        upserted_count integer not null default 0,
        updated_count integer not null default 0,
        skipped_count integer not null default 0,
        error_code text,
        error_message text
      );

      create index if not exists idx_pf_sync_runs_source_started_at
        on pf_sync_runs(source_id, started_at);
      create index if not exists idx_pf_sync_runs_user_started_at
        on pf_sync_runs(user_id, started_at);

      create table if not exists pf_sync_state (
        source_id text primary key not null,
        user_id text not null default '',
        sync_strategy text not null default 'polling',
        cursor_json text,
        last_success_at text,
        last_watermark_at text,
        last_backfill_at text,
        updated_at text not null,
        foreign key (source_id) references pf_connected_sources(id)
      );
    `);

    this.database.exec(`
      create virtual table if not exists pf_context_items_fts using fts5(
        item_id unindexed,
        title,
        content_text,
        search_text
      )
    `);

    this.ensureColumn(
      "pf_connected_sources",
      "user_id",
      "user_id text not null default ''",
    );
    this.ensureColumn(
      "pf_context_items",
      "user_id",
      "user_id text not null default ''",
    );
    this.ensureColumn(
      "pf_sync_runs",
      "user_id",
      "user_id text",
    );
    this.ensureColumn(
      "pf_sync_state",
      "user_id",
      "user_id text not null default ''",
    );

    this.schemaReady = true;
  }

  async listSources(): Promise<PersonalConnectedSourceRecord[]> {
    await this.ensureSchema();

    const rows = this.database.all<PersonalConnectedSourceRow>(
      `
        select
          id,
          user_id,
          provider,
          toolkit,
          connected_account_id,
          account_label,
          status,
          sync_enabled,
          scopes_json,
          auth_metadata_json,
          last_seen_at,
          created_at,
          updated_at
        from pf_connected_sources
        order by toolkit asc, id asc
      `,
    );

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      toolkit: row.toolkit,
      connectedAccountId: row.connected_account_id,
      accountLabel: row.account_label,
      status: row.status,
      syncEnabled: row.sync_enabled === 1,
      scopesJson: row.scopes_json,
      authMetadataJson: row.auth_metadata_json,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async listSyncStates(sourceId?: string): Promise<PersonalSyncStateRecord[]> {
    await this.ensureSchema();
    const params: unknown[] = [];
    const where = sourceId ? "where source_id = ?" : "";
    if (sourceId) {
      params.push(sourceId);
    }

    const rows = this.database.all<PersonalSyncStateRow>(
      `
        select
          source_id,
          user_id,
          sync_strategy,
          cursor_json,
          last_success_at,
          last_watermark_at,
          last_backfill_at,
          updated_at
        from pf_sync_state
        ${where}
        order by source_id asc
      `,
      params,
    );

    return rows.map((row) => ({
      sourceId: row.source_id,
      userId: row.user_id,
      syncStrategy: row.sync_strategy,
      cursorJson: row.cursor_json,
      lastSuccessAt: row.last_success_at,
      lastWatermarkAt: row.last_watermark_at,
      lastBackfillAt: row.last_backfill_at,
      updatedAt: row.updated_at,
    }));
  }

  async listSyncRuns(input?: {
    sourceId?: string;
    limit?: number;
  }): Promise<PersonalSyncRunRecord[]> {
    await this.ensureSchema();

    const params: unknown[] = [];
    const where = input?.sourceId ? "where source_id = ?" : "";
    if (input?.sourceId) {
      params.push(input.sourceId);
    }
    params.push(input?.limit ?? 10);

    const rows = this.database.all<PersonalSyncRunRow>(
      `
        select
          id,
          source_id,
          user_id,
          mode,
          status,
          started_at,
          finished_at,
          cursor_before_json,
          cursor_after_json,
          fetched_count,
          upserted_count,
          updated_count,
          skipped_count,
          error_code,
          error_message
        from pf_sync_runs
        ${where}
        order by started_at desc, id desc
        limit ?
      `,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      userId: row.user_id,
      mode: row.mode,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      cursorBeforeJson: row.cursor_before_json,
      cursorAfterJson: row.cursor_after_json,
      fetchedCount: row.fetched_count,
      upsertedCount: row.upserted_count,
      updatedCount: row.updated_count,
      skippedCount: row.skipped_count,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    }));
  }

  async upsertSources(
    inputs: UpsertPersonalConnectedSourceInput[],
  ): Promise<number> {
    await this.ensureSchema();

    const now = new Date().toISOString();
    const statement = this.database.client.prepare(`
      insert into pf_connected_sources (
        id,
        user_id,
        provider,
        toolkit,
        connected_account_id,
        account_label,
        status,
        sync_enabled,
        scopes_json,
        auth_metadata_json,
        last_seen_at,
        created_at,
        updated_at
      ) values (
        @id,
        @user_id,
        @provider,
        @toolkit,
        @connected_account_id,
        @account_label,
        @status,
        @sync_enabled,
        @scopes_json,
        @auth_metadata_json,
        @last_seen_at,
        @created_at,
        @updated_at
      )
      on conflict(id) do update set
        provider = excluded.provider,
        user_id = excluded.user_id,
        toolkit = excluded.toolkit,
        connected_account_id = excluded.connected_account_id,
        account_label = excluded.account_label,
        status = excluded.status,
        sync_enabled = excluded.sync_enabled,
        scopes_json = excluded.scopes_json,
        auth_metadata_json = excluded.auth_metadata_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);

    const transaction = this.database.client.transaction(
      (rows: UpsertPersonalConnectedSourceInput[]) => {
        for (const row of rows) {
          statement.run({
            id: row.id,
            user_id: row.userId,
            provider: row.provider,
            toolkit: row.toolkit,
            connected_account_id: row.connectedAccountId,
            account_label: row.accountLabel ?? null,
            status: row.status,
            sync_enabled: row.syncEnabled ? 1 : 0,
            scopes_json: row.scopesJson ?? null,
            auth_metadata_json: row.authMetadataJson ?? null,
            last_seen_at: row.lastSeenAt ?? now,
            created_at: now,
            updated_at: now,
          });
        }
      },
    );

    transaction(inputs);
    return inputs.length;
  }

  async upsertSyncStates(
    inputs: UpsertPersonalSyncStateInput[],
  ): Promise<number> {
    await this.ensureSchema();

    const now = new Date().toISOString();
    const statement = this.database.client.prepare(`
      insert into pf_sync_state (
        source_id,
        user_id,
        sync_strategy,
        cursor_json,
        last_success_at,
        last_watermark_at,
        last_backfill_at,
        updated_at
      ) values (
        @source_id,
        @user_id,
        @sync_strategy,
        @cursor_json,
        @last_success_at,
        @last_watermark_at,
        @last_backfill_at,
        @updated_at
      )
      on conflict(source_id) do update set
        sync_strategy = excluded.sync_strategy,
        user_id = excluded.user_id,
        cursor_json = coalesce(excluded.cursor_json, pf_sync_state.cursor_json),
        last_success_at = coalesce(excluded.last_success_at, pf_sync_state.last_success_at),
        last_watermark_at = coalesce(excluded.last_watermark_at, pf_sync_state.last_watermark_at),
        last_backfill_at = coalesce(excluded.last_backfill_at, pf_sync_state.last_backfill_at),
        updated_at = excluded.updated_at
    `);

    const transaction = this.database.client.transaction(
      (rows: UpsertPersonalSyncStateInput[]) => {
        for (const row of rows) {
          statement.run({
            source_id: row.sourceId,
            user_id: row.userId,
            sync_strategy: row.syncStrategy,
            cursor_json: row.cursorJson ?? null,
            last_success_at: row.lastSuccessAt ?? null,
            last_watermark_at: row.lastWatermarkAt ?? null,
            last_backfill_at: row.lastBackfillAt ?? null,
            updated_at: now,
          });
        }
      },
    );

    transaction(inputs);
    return inputs.length;
  }

  async upsertContextItems(
    inputs: UpsertPersonalContextItemInput[],
  ): Promise<number> {
    await this.ensureSchema();

    const now = new Date().toISOString();
    const itemStatement = this.database.client.prepare(`
      insert into pf_context_items (
        id,
        source_id,
        user_id,
        toolkit,
        item_type,
        external_id,
        external_parent_id,
        title,
        content_text,
        url,
        occurred_at,
        synced_at,
        content_hash,
        attributes_json,
        raw_json,
        search_text,
        is_deleted,
        created_at,
        updated_at
      ) values (
        @id,
        @source_id,
        @user_id,
        @toolkit,
        @item_type,
        @external_id,
        @external_parent_id,
        @title,
        @content_text,
        @url,
        @occurred_at,
        @synced_at,
        @content_hash,
        @attributes_json,
        @raw_json,
        @search_text,
        @is_deleted,
        @created_at,
        @updated_at
      )
      on conflict(id) do update set
        source_id = excluded.source_id,
        user_id = excluded.user_id,
        toolkit = excluded.toolkit,
        item_type = excluded.item_type,
        external_id = excluded.external_id,
        external_parent_id = excluded.external_parent_id,
        title = excluded.title,
        content_text = excluded.content_text,
        url = excluded.url,
        occurred_at = excluded.occurred_at,
        synced_at = excluded.synced_at,
        content_hash = excluded.content_hash,
        attributes_json = excluded.attributes_json,
        raw_json = excluded.raw_json,
        search_text = excluded.search_text,
        is_deleted = excluded.is_deleted,
        updated_at = excluded.updated_at
    `);

    const ftsDeleteStatement = this.database.client.prepare(`
      delete from pf_context_items_fts where item_id = ?
    `);
    const ftsInsertStatement = this.database.client.prepare(`
      insert into pf_context_items_fts (
        item_id,
        title,
        content_text,
        search_text
      ) values (?, ?, ?, ?)
    `);

    const transaction = this.database.client.transaction(
      (rows: UpsertPersonalContextItemInput[]) => {
        for (const row of rows) {
          itemStatement.run({
            id: row.id,
            source_id: row.sourceId,
            user_id: row.userId,
            toolkit: row.toolkit,
            item_type: row.itemType,
            external_id: row.externalId,
            external_parent_id: row.externalParentId ?? null,
            title: row.title ?? null,
            content_text: row.contentText ?? null,
            url: row.url ?? null,
            occurred_at: row.occurredAt ?? null,
            synced_at: row.syncedAt,
            content_hash: row.contentHash ?? null,
            attributes_json: row.attributesJson ?? "{}",
            raw_json: row.rawJson,
            search_text: row.searchText ?? "",
            is_deleted: row.isDeleted ? 1 : 0,
            created_at: now,
            updated_at: now,
          });

          ftsDeleteStatement.run(row.id);
          if (!row.isDeleted) {
            ftsInsertStatement.run(
              row.id,
              row.title ?? "",
              row.contentText ?? "",
              row.searchText ?? "",
            );
          }
        }
      },
    );

    transaction(inputs);
    return inputs.length;
  }

  async getItemById(id: string): Promise<PersonalContextItemRecord | null> {
    await this.ensureSchema();

    const row = this.database.get<PersonalContextItemRow>(
      `
        select
          id,
          source_id,
          user_id,
          toolkit,
          item_type,
          external_id,
          external_parent_id,
          title,
          content_text,
          url,
          occurred_at,
          synced_at,
          content_hash,
          attributes_json,
          raw_json,
          search_text,
          is_deleted,
          created_at,
          updated_at
        from pf_context_items
        where id = ?
      `,
      [id],
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sourceId: row.source_id,
      userId: row.user_id,
      toolkit: row.toolkit,
      itemType: row.item_type,
      externalId: row.external_id,
      externalParentId: row.external_parent_id,
      title: row.title,
      contentText: row.content_text,
      url: row.url,
      occurredAt: row.occurred_at,
      syncedAt: row.synced_at,
      contentHash: row.content_hash,
      attributesJson: row.attributes_json,
      rawJson: row.raw_json,
      searchText: row.search_text,
      isDeleted: row.is_deleted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private applyCommonItemFilters(
    conditions: string[],
    params: unknown[],
    input: PersonalItemQueryInput,
    alias = "i",
  ): void {
    conditions.push(`${alias}.is_deleted = 0`);

    if (input.from) {
      conditions.push(`${alias}.occurred_at >= ?`);
      params.push(input.from);
    }

    if (input.to) {
      conditions.push(`${alias}.occurred_at <= ?`);
      params.push(input.to);
    }

    if (input.sourceIds && input.sourceIds.length > 0) {
      conditions.push(
        `${alias}.source_id in (${input.sourceIds.map(() => "?").join(", ")})`,
      );
      params.push(...input.sourceIds);
    }

    if (input.toolkits && input.toolkits.length > 0) {
      conditions.push(
        `${alias}.toolkit in (${input.toolkits.map(() => "?").join(", ")})`,
      );
      params.push(...input.toolkits);
    }

    if (input.itemTypes && input.itemTypes.length > 0) {
      conditions.push(
        `${alias}.item_type in (${input.itemTypes.map(() => "?").join(", ")})`,
      );
      params.push(...input.itemTypes);
    }

    if (input.facet) {
      conditions.push(`json_extract(${alias}.attributes_json, ?) = ?`);
      params.push(`$.${input.facet.key}`, input.facet.value);
    }
  }

  async searchItems(
    query: string,
    input: PersonalItemQueryInput,
  ): Promise<PersonalSearchResultRecord[]> {
    await this.ensureSchema();

    const conditions: string[] = ["pf_context_items_fts match ?"];
    const params: unknown[] = [query];
    this.applyCommonItemFilters(conditions, params, input);
    params.push(input.limit ?? 10);

    const rows = this.database.all<PersonalSearchRow>(
      `
        select
          i.id,
          i.source_id,
          i.user_id,
          i.toolkit,
          i.item_type,
          i.occurred_at,
          i.title,
          i.url,
          snippet(pf_context_items_fts, 3, '', '', ' … ', 16) as snippet,
          bm25(pf_context_items_fts) as score,
          i.attributes_json
        from pf_context_items_fts
        join pf_context_items i on i.id = pf_context_items_fts.item_id
        where ${conditions.join(" and ")}
        order by bm25(pf_context_items_fts) asc, i.occurred_at desc
        limit ?
      `,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      userId: row.user_id,
      toolkit: row.toolkit,
      itemType: row.item_type,
      occurredAt: row.occurred_at,
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      score: row.score,
      attributesJson: row.attributes_json,
    }));
  }

  async listItemsInTimeline(
    input: PersonalItemQueryInput,
  ): Promise<PersonalSearchResultRecord[]> {
    await this.ensureSchema();

    const conditions: string[] = [];
    const params: unknown[] = [];
    this.applyCommonItemFilters(conditions, params, input);
    params.push(input.limit ?? 20);

    const rows = this.database.all<PersonalSearchRow>(
      `
        select
          i.id,
          i.source_id,
          i.user_id,
          i.toolkit,
          i.item_type,
          i.occurred_at,
          i.title,
          i.url,
          i.content_text as snippet,
          null as score,
          i.attributes_json
        from pf_context_items i
        where ${conditions.join(" and ")}
        order by coalesce(i.occurred_at, i.synced_at) desc, i.id desc
        limit ?
      `,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      userId: row.user_id,
      toolkit: row.toolkit,
      itemType: row.item_type,
      occurredAt: row.occurred_at,
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      score: row.score,
      attributesJson: row.attributes_json,
    }));
  }

  async insertSyncRun(input: PersonalSyncRunInput): Promise<void> {
    await this.ensureSchema();

    this.database.client.prepare(`
      insert into pf_sync_runs (
        id,
        source_id,
        user_id,
        mode,
        status,
        started_at,
        finished_at,
        cursor_before_json,
        cursor_after_json,
        fetched_count,
        upserted_count,
        updated_count,
        skipped_count,
        error_code,
        error_message
      ) values (
        @id,
        @source_id,
        @user_id,
        @mode,
        @status,
        @started_at,
        @finished_at,
        @cursor_before_json,
        @cursor_after_json,
        @fetched_count,
        @upserted_count,
        @updated_count,
        @skipped_count,
        @error_code,
        @error_message
      )
    `).run({
      id: input.id,
      source_id: input.sourceId ?? null,
      user_id: input.userId ?? null,
      mode: input.mode,
      status: input.status,
      started_at: input.startedAt,
      finished_at: input.finishedAt ?? null,
      cursor_before_json: input.cursorBeforeJson ?? null,
      cursor_after_json: input.cursorAfterJson ?? null,
      fetched_count: input.fetchedCount ?? 0,
      upserted_count: input.upsertedCount ?? 0,
      updated_count: input.updatedCount ?? 0,
      skipped_count: input.skippedCount ?? 0,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
    });
  }
}
