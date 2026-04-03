import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { SqliteDatabase } from "../../db/sqlite_adapter.js";
import {
  type NewWorldItemRecord,
  type WorldItemRecord,
  worldItems,
} from "./schema.js";

export interface IngestWorldItemInput {
  provider: string;
  streamType?: string;
  title: string;
  url: string;
  externalId?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  query: string;
  topics?: string[];
  regions?: string[];
  importance?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListWorldItemsInput {
  limit?: number;
  query?: string;
  since?: string;
  until?: string;
  afterId?: string;
  afterUpdatedAt?: string;
}

export interface WorldSemanticIndexCandidateRecord extends WorldItemRecord {
  searchText: string;
}

const normalizeUrl = (raw: string): string => {
  try {
    const url = new URL(raw.trim());
    url.hash = "";

    const nextParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key.toLowerCase().startsWith("utm_")) {
        continue;
      }
      nextParams.append(key, value);
    }

    const nextSearch = nextParams.toString();
    url.search = nextSearch ? `?${nextSearch}` : "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return raw.trim();
  }
};

const buildWorldItemId = (
  normalizedUrl: string,
  input: IngestWorldItemInput,
): string =>
  createHash("sha256")
    .update(
      [
        normalizedUrl,
        input.provider,
        input.externalId ?? "",
        input.title.trim(),
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);

export class WorldRepository {
  private schemaReady = false;

  constructor(private readonly database: SqliteDatabase) {}

  async ingest(input: IngestWorldItemInput): Promise<WorldItemRecord> {
    await this.ensureSchema();

    const normalizedUrl = normalizeUrl(input.url);
    const existing = this.database.orm
      .select()
      .from(worldItems)
      .where(eq(worldItems.normalizedUrl, normalizedUrl))
      .limit(1)
      .all()[0];

    const now = new Date().toISOString();
    const nextQueries = existing
      ? Array.from(new Set([...(existing.searchQueries ?? []), input.query]))
      : [input.query];

    if (existing) {
      const updated = this.database.orm
        .update(worldItems)
        .set({
          provider: input.provider,
          streamType: input.streamType ?? existing.streamType,
          title: input.title,
          url: input.url,
          externalId: input.externalId ?? existing.externalId ?? null,
          summary: input.summary ?? existing.summary ?? null,
          publishedAt: input.publishedAt ?? existing.publishedAt ?? null,
          searchQueries: nextQueries,
          topics: Array.from(new Set([...(existing.topics ?? []), ...(input.topics ?? [])])),
          regions: Array.from(new Set([...(existing.regions ?? []), ...(input.regions ?? [])])),
          importance: input.importance ?? existing.importance ?? null,
          metadata: {
            ...(existing.metadata ?? {}),
            ...(input.metadata ?? {}),
          },
          updatedAt: now,
        })
        .where(eq(worldItems.id, existing.id))
        .returning()
        .all()[0];

      return updated;
    }

    const values: NewWorldItemRecord = {
      id: buildWorldItemId(normalizedUrl, input),
      provider: input.provider,
      streamType: input.streamType ?? "search",
      title: input.title,
      url: input.url,
      normalizedUrl,
      externalId: input.externalId ?? null,
      summary: input.summary ?? null,
      publishedAt: input.publishedAt ?? null,
      searchQueries: nextQueries,
      topics: input.topics ?? [],
      regions: input.regions ?? [],
      importance: input.importance ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.database.orm.insert(worldItems).values(values).run();
    return this.getById(values.id) as Promise<WorldItemRecord>;
  }

  async list(input: ListWorldItemsInput = {}): Promise<WorldItemRecord[]> {
    await this.ensureSchema();
    const limit = input.limit ?? 20;
    const items = this.database.orm
      .select()
      .from(worldItems)
      .orderBy(desc(worldItems.publishedAt), desc(worldItems.updatedAt))
      .all();

    const filtered = items.filter((item) => {
      if (input.query) {
        const haystack = [
          item.title,
          item.summary ?? "",
          ...(item.searchQueries ?? []),
          item.provider,
        ]
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(input.query.trim().toLowerCase())) {
          return false;
        }
      }

      if (input.since) {
        const itemTs = item.publishedAt ?? item.updatedAt;
        if (itemTs < input.since) {
          return false;
        }
      }

      if (input.until) {
        const itemTs = item.publishedAt ?? item.updatedAt;
        if (itemTs > input.until) {
          return false;
        }
      }

      if (input.afterUpdatedAt) {
        if (item.updatedAt <= input.afterUpdatedAt) {
          return false;
        }
      }

      return true;
    });

    const afterCursor = input.afterId
      ? (() => {
          const cursorIndex = filtered.findIndex((item) => item.id === input.afterId);
          return cursorIndex >= 0 ? filtered.slice(cursorIndex + 1) : filtered;
        })()
      : filtered;

    return afterCursor.slice(0, limit);
  }

  async getById(id: string): Promise<WorldItemRecord | null> {
    await this.ensureSchema();
    const result = this.database.orm
      .select()
      .from(worldItems)
      .where(eq(worldItems.id, id))
      .limit(1)
      .all();

    return result[0] ?? null;
  }

  async searchStored(query: string, limit = 20): Promise<WorldItemRecord[]> {
    return this.list({
      query,
      limit,
    });
  }

  async listByIds(ids: string[]): Promise<WorldItemRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const all = await this.list({ limit: Math.max(ids.length * 5, 100) });
    const order = new Map(ids.map((id, index) => [id, index]));
    return all
      .filter((item) => order.has(item.id))
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }

  async listSemanticIndexCandidates(
    options?: { all?: boolean; limit?: number },
  ): Promise<WorldSemanticIndexCandidateRecord[]> {
    const items = await this.list({
      limit: options?.limit ?? 100,
    });

    return items.map((item) => ({
      ...item,
      searchText: [
        item.title,
        item.summary ?? "",
        ...(item.topics ?? []),
        ...(item.regions ?? []),
        ...(item.searchQueries ?? []),
        item.provider,
        item.streamType,
        item.importance ?? "",
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    }));
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    this.database.exec(`
      create table if not exists world_items (
        id text primary key not null,
        provider text not null,
        stream_type text not null default 'search',
        title text not null,
        url text not null,
        normalized_url text not null unique,
        external_id text,
        summary text,
        published_at text,
        search_queries text not null default '[]',
        topics text not null default '[]',
        regions text not null default '[]',
        importance text,
        metadata text not null default '{}',
        created_at text not null,
        updated_at text not null
      )
    `);

    const columns = this.database.all<{ name: string }>(
      "pragma table_info(world_items)",
    );
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("search_queries")) {
      this.database.exec(
        "alter table world_items add column search_queries text not null default '[]'",
      );
    }

    if (!columnNames.has("stream_type")) {
      this.database.exec(
        "alter table world_items add column stream_type text not null default 'search'",
      );
    }

    if (!columnNames.has("topics")) {
      this.database.exec(
        "alter table world_items add column topics text not null default '[]'",
      );
    }

    if (!columnNames.has("regions")) {
      this.database.exec(
        "alter table world_items add column regions text not null default '[]'",
      );
    }

    if (!columnNames.has("importance")) {
      this.database.exec("alter table world_items add column importance text");
    }

    if (!columnNames.has("metadata")) {
      this.database.exec(
        "alter table world_items add column metadata text not null default '{}'",
      );
    }

    this.schemaReady = true;
  }
}
