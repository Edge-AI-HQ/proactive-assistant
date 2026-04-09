import { mkdir } from "node:fs/promises";

import type { CoreContext } from "../../context.js";
import { resolveAppRootFromCtx } from "../../paths.js";

export interface WorldSemanticIndexRecord {
  id: string;
  provider: string;
  streamType: string;
  publishedAt: string | null;
  title: string | null;
  url: string | null;
  summary: string | null;
  topicsJson: string;
  regionsJson: string;
  importance: string | null;
  searchText: string;
  vector: number[];
}

export interface WorldSemanticSearchHit {
  id: string;
  score: number;
}

export interface WorldSemanticIndexRefreshResult {
  upsertedCount: number;
  deletedCount: number;
}

export interface WorldSemanticIndex {
  refresh(
    records: WorldSemanticIndexRecord[],
    options?: { replaceAll?: boolean },
  ): Promise<WorldSemanticIndexRefreshResult>;
  search(
    vector: number[],
    options?: { limit?: number },
  ): Promise<WorldSemanticSearchHit[]>;
  isReady(): Promise<boolean>;
}

const asLanceRows = (
  records: WorldSemanticIndexRecord[],
): Record<string, unknown>[] =>
  records.map((record) => ({
    id: record.id,
    provider: record.provider,
    streamType: record.streamType,
    publishedAt: record.publishedAt,
    title: record.title,
    url: record.url,
    summary: record.summary,
    topicsJson: record.topicsJson,
    regionsJson: record.regionsJson,
    importance: record.importance,
    searchText: record.searchText,
    vector: record.vector,
  }));

class NoopWorldSemanticIndex implements WorldSemanticIndex {
  async refresh(): Promise<WorldSemanticIndexRefreshResult> {
    return {
      upsertedCount: 0,
      deletedCount: 0,
    };
  }

  async search(): Promise<WorldSemanticSearchHit[]> {
    return [];
  }

  async isReady(): Promise<boolean> {
    return false;
  }
}

class LanceDbWorldSemanticIndex implements WorldSemanticIndex {
  private readonly uri: string;
  private readonly tableName = "pf_world_semantic_items";

  constructor(dataRoot: string) {
    this.uri = `${dataRoot}/index/world.lancedb`;
  }

  private async openConnector() {
    const module = await import("@lancedb/lancedb");
    return module.connect;
  }

  private async openConnection() {
    await mkdir(this.uri, { recursive: true });
    const connect = await this.openConnector();
    return connect(this.uri);
  }

  private async openTable() {
    const conn = await this.openConnection();
    try {
      return await conn.openTable(this.tableName);
    } catch {
      return null;
    }
  }

  async refresh(
    records: WorldSemanticIndexRecord[],
    options?: { replaceAll?: boolean },
  ): Promise<WorldSemanticIndexRefreshResult> {
    if (records.length === 0) {
      return {
        upsertedCount: 0,
        deletedCount: 0,
      };
    }

    const conn = await this.openConnection();
    let table;
    try {
      table = await conn.openTable(this.tableName);
    } catch {
      await conn.createTable(this.tableName, asLanceRows(records));
      return {
        upsertedCount: records.length,
        deletedCount: 0,
      };
    }

    let deletedCount = 0;
    const merge = table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll();

    if (options?.replaceAll) {
      merge.whenNotMatchedBySourceDelete();
    }

    await merge.execute(asLanceRows(records));
    if (options?.replaceAll) {
      deletedCount = 0;
    }

    return {
      upsertedCount: records.length,
      deletedCount,
    };
  }

  async search(
    vector: number[],
    options?: { limit?: number },
  ): Promise<WorldSemanticSearchHit[]> {
    const table = await this.openTable();
    if (!table) {
      return [];
    }

    const rows = await table
      .search(vector)
      .limit(options?.limit ?? 10)
      .select(["id", "_distance"])
      .toArray();

    return rows
      .map((row) => {
        const data = row as Record<string, unknown>;
        const id = typeof data.id === "string" ? data.id : null;
        const distance =
          typeof data._distance === "number" ? data._distance : null;
        if (!id) {
          return null;
        }
        return {
          id,
          score: distance === null ? 0 : 1 / (1 + distance),
        };
      })
      .filter((row): row is WorldSemanticSearchHit => row !== null);
  }

  async isReady(): Promise<boolean> {
    const table = await this.openTable();
    if (!table) {
      return false;
    }

    return (await table.countRows()) > 0;
  }
}

export const createWorldSemanticIndex = (
  ctx: CoreContext,
  override?: WorldSemanticIndex,
): WorldSemanticIndex => {
  if (override) {
    return override;
  }

  const enabled = ctx.env.PIN_WORLD_SEMANTIC_INDEX ?? "1";
  if (enabled === "0" || enabled.toLowerCase() === "false") {
    return new NoopWorldSemanticIndex();
  }

  const dataRoot = resolveAppRootFromCtx(ctx);
  return new LanceDbWorldSemanticIndex(dataRoot);
};
