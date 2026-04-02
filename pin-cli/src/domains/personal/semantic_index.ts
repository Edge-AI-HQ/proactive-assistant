import { mkdir } from "node:fs/promises";

import { connect } from "@lancedb/lancedb";

import type { CliRuntimeInput } from "../../runtime.js";

export interface PersonalSemanticIndexRecord {
  id: string;
  userId: string;
  sourceId: string;
  toolkit: string;
  itemType: string;
  occurredAt: string | null;
  title: string | null;
  url: string | null;
  attributesJson: string;
  searchText: string;
  vector: number[];
}

export interface PersonalSemanticSearchHit {
  id: string;
  score: number;
}

export interface PersonalSemanticIndexRefreshResult {
  upsertedCount: number;
  deletedCount: number;
}

export interface PersonalSemanticIndex {
  refresh(
    records: PersonalSemanticIndexRecord[],
    options?: { replaceAll?: boolean },
  ): Promise<PersonalSemanticIndexRefreshResult>;
  search(
    vector: number[],
    options?: { limit?: number },
  ): Promise<PersonalSemanticSearchHit[]>;
  isReady(): Promise<boolean>;
}

const asLanceRows = (
  records: PersonalSemanticIndexRecord[],
): Record<string, unknown>[] =>
  records.map((record) => ({
    id: record.id,
    userId: record.userId,
    sourceId: record.sourceId,
    toolkit: record.toolkit,
    itemType: record.itemType,
    occurredAt: record.occurredAt,
    title: record.title,
    url: record.url,
    attributesJson: record.attributesJson,
    searchText: record.searchText,
    vector: record.vector,
  }));

class NoopPersonalSemanticIndex implements PersonalSemanticIndex {
  async refresh(): Promise<PersonalSemanticIndexRefreshResult> {
    return {
      upsertedCount: 0,
      deletedCount: 0,
    };
  }

  async search(): Promise<PersonalSemanticSearchHit[]> {
    return [];
  }

  async isReady(): Promise<boolean> {
    return false;
  }
}

class LanceDbPersonalSemanticIndex implements PersonalSemanticIndex {
  private readonly uri: string;
  private readonly tableName = "pf_personal_semantic_items";

  constructor(dataRoot: string) {
    this.uri = `${dataRoot}/index/personal.lancedb`;
  }

  private async openConnection() {
    await mkdir(this.uri, { recursive: true });
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
    records: PersonalSemanticIndexRecord[],
    options?: { replaceAll?: boolean },
  ): Promise<PersonalSemanticIndexRefreshResult> {
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
  ): Promise<PersonalSemanticSearchHit[]> {
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
      .filter((row): row is PersonalSemanticSearchHit => row !== null);
  }

  async isReady(): Promise<boolean> {
    const table = await this.openTable();
    if (!table) {
      return false;
    }

    return (await table.countRows()) > 0;
  }
}

export const createPersonalSemanticIndex = (
  runtime: CliRuntimeInput,
  override?: PersonalSemanticIndex,
): PersonalSemanticIndex => {
  if (override) {
    return override;
  }

  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  return new LanceDbPersonalSemanticIndex(dataRoot);
};
