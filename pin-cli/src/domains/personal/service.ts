import { randomUUID } from "node:crypto";

import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import {
  createPersonalToolExecutor,
  type PersonalToolExecutor,
} from "./executor.js";
import {
  createPersonalSourceProvider,
  type PersonalSourceProvider,
} from "./provider.js";
import {
  PersonalRepository,
  type PersonalConnectedSourceRecord,
  type PersonalContextItemRecord,
  type PersonalItemQueryInput,
  type PersonalSearchResultRecord,
  type PersonalSyncRunRecord,
  type PersonalSyncStateRecord,
} from "./repository.js";
import {
  getPersonalSyncSpec,
  isPersonalSyncSupported,
} from "./sync_specs.js";

const createRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new PersonalRepository(manager.open("pin"));
};

const parseJsonObject = (
  raw: string | null | undefined,
): Record<string, unknown> => {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const syncSourceItems = async (
  source: PersonalConnectedSourceRecord,
  executor: PersonalToolExecutor,
  syncedAt: string,
) => {
  const syncSpec = getPersonalSyncSpec(source.toolkit);
  if (!syncSpec) {
    return [];
  }

  return syncSpec.sync({
    source,
    executor,
    syncedAt,
  });
};

const getSourceSyncSkipReason = (
  source: PersonalConnectedSourceRecord,
): string | null => {
  if (source.status.toUpperCase() !== "ACTIVE") {
    return `source status is ${source.status}`;
  }

  if (!source.syncEnabled) {
    return "source sync is disabled";
  }

  if (!isPersonalSyncSupported(source.toolkit)) {
    return `toolkit ${source.toolkit} is not supported yet`;
  }

  return null;
};

const toPublicItem = (
  row: PersonalContextItemRecord,
  includeRaw: boolean,
): Record<string, unknown> => {
  const attributes = parseJsonObject(row.attributesJson);
  const raw = parseJsonObject(row.rawJson);

  return {
    id: row.id,
    sourceId: row.sourceId,
    userId: row.userId,
    toolkit: row.toolkit,
    itemType: row.itemType,
    externalId: row.externalId,
    externalParentId: row.externalParentId,
    title: row.title,
    contentText: row.contentText,
    url: row.url,
    occurredAt: row.occurredAt,
    syncedAt: row.syncedAt,
    attributes,
    ...(includeRaw ? { raw } : {}),
  };
};

const parseCsv = (raw?: string): string[] =>
  raw
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

const parseFacet = (
  raw?: string,
): { key: string; value: string } | null => {
  if (!raw) {
    return null;
  }

  const index = raw.indexOf("=");
  if (index <= 0 || index === raw.length - 1) {
    return null;
  }

  return {
    key: raw.slice(0, index).trim(),
    value: raw.slice(index + 1).trim(),
  };
};

const toItemQueryInput = (input: {
  from?: string;
  to?: string;
  source?: string;
  toolkit?: string;
  type?: string;
  facet?: string;
  limit?: string | number;
}): PersonalItemQueryInput => ({
  from: input.from ?? null,
  to: input.to ?? null,
  sourceIds: parseCsv(input.source),
  toolkits: parseCsv(input.toolkit),
  itemTypes: parseCsv(input.type),
  facet: parseFacet(input.facet),
  limit:
    typeof input.limit === "number"
      ? input.limit
      : Number.parseInt(input.limit ?? "", 10) || undefined,
});

const toSearchResult = (
  row: PersonalSearchResultRecord,
): Record<string, unknown> => ({
  id: row.id,
  sourceId: row.sourceId,
  userId: row.userId,
  toolkit: row.toolkit,
  itemType: row.itemType,
  occurredAt: row.occurredAt,
  title: row.title,
  url: row.url,
  snippet: row.snippet,
  score: row.score,
  matchReason: row.score === null ? "timeline" : "keyword",
  attributes: parseJsonObject(row.attributesJson),
});

export const listPersonalSources = async (
  runtime: CliRuntimeInput,
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const sources = await repository.listSources();

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "personal",
      "source list",
      sources.map((source) => ({
        ...source,
        syncSupported:
          source.syncEnabled && source.status.toUpperCase() === "ACTIVE"
            ? isPersonalSyncSupported(source.toolkit)
            : false,
      })),
    ),
  };
};

export const listPersonalSyncStatus = async (
  runtime: CliRuntimeInput,
  input?: { source?: string; recent?: string | number },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const states = await repository.listSyncStates(input?.source);
  const recentRuns = await repository.listSyncRuns({
    sourceId: input?.source,
    limit:
      typeof input?.recent === "number"
        ? input.recent
        : Number.parseInt(input?.recent ?? "", 10) || 10,
  });

  return {
    exitCode: 0,
    stdout: okEnvelope<{
      states: PersonalSyncStateRecord[];
      recentRuns: PersonalSyncRunRecord[];
    }>(
      "personal",
      "sync status",
      {
        states,
        recentRuns,
      },
    ),
  };
};

export const getPersonalItem = async (
  runtime: CliRuntimeInput,
  id: string,
  options?: { includeRaw?: boolean },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const item = await repository.getItemById(id);

  if (!item) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal",
        "item get",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Personal item ${id} not found`,
        "run `pin personal search --query ...` or `pin personal timeline ...` to inspect available items",
      ),
    };
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("personal", "item get", toPublicItem(item, options?.includeRaw === true)),
  };
};

export const searchPersonalItems = async (
  runtime: CliRuntimeInput,
  input: {
    query: string;
    strategy?: string;
    from?: string;
    to?: string;
    source?: string;
    toolkit?: string;
    type?: string;
    facet?: string;
    limit?: string | number;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const queryInput = toItemQueryInput(input);
  const strategy = input.strategy ?? "keyword";
  const results = await repository.searchItems(input.query, queryInput);
  const degraded =
    strategy === "semantic" || strategy === "hybrid"
      ? {
          search: {
            message: "语义索引尚未接入，当前已降级为关键词检索",
            hint: "下一步会把 LanceDB embedding 索引接上",
          },
        }
      : undefined;

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "personal",
      "search",
      {
        strategy:
          strategy === "semantic" || strategy === "hybrid"
            ? "keyword"
            : strategy,
        degraded: degraded ? true : false,
        results: results.map(toSearchResult),
      },
      degraded,
    ),
  };
};

export const timelinePersonalItems = async (
  runtime: CliRuntimeInput,
  input: {
    from: string;
    to: string;
    source?: string;
    toolkit?: string;
    type?: string;
    limit?: string | number;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const results = await repository.listItemsInTimeline(toItemQueryInput(input));

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "personal",
      "timeline",
      results.map(toSearchResult),
    ),
  };
};

export const runPersonalSync = async (
  runtime: CliRuntimeInput,
  input: { mode?: string; all?: boolean; source?: string },
  deps?: { provider?: PersonalSourceProvider; executor?: PersonalToolExecutor },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const provider = createPersonalSourceProvider(runtime, deps?.provider);
  const executor = createPersonalToolExecutor(runtime, deps?.executor);
  const startedAt = new Date().toISOString();
  const discoveredSources = await provider.listConnectedSources();
  const persistedSourceCount = await repository.upsertSources(discoveredSources);
  const knownSources = await repository.listSources();
  const targetSources = knownSources.filter((source) => {
    if (input.all) {
      return true;
    }
    if (input.source) {
      return source.id === input.source;
    }
    return false;
  });

  if (input.source && targetSources.length === 0) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "personal",
        "sync run",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Personal source ${input.source} not found`,
        "run `pin personal source list --json` to inspect available sources",
      ),
    };
  }

  let fetchedCount = 0;
  let upsertedCount = 0;
  let syncedSourcesCount = 0;
  const failures: Array<{ sourceId: string; message: string }> = [];
  let skippedSourcesCount = 0;

  await repository.upsertSyncStates(
    targetSources.map((source) => ({
      sourceId: source.id,
      userId: source.userId,
      syncStrategy: "polling",
    })),
  );

  for (const source of targetSources) {
    const skipReason = getSourceSyncSkipReason(source);
    if (skipReason) {
      skippedSourcesCount += 1;
      await repository.insertSyncRun({
        id: randomUUID(),
        sourceId: source.id,
        userId: source.userId,
        mode: input.mode ?? "incremental",
        status: "skipped",
        startedAt,
        finishedAt: new Date().toISOString(),
        skippedCount: 1,
        errorCode: "SOURCE_SKIPPED",
        errorMessage: skipReason,
      });
      continue;
    }

    try {
      const items = await syncSourceItems(source, executor, startedAt);
      const sourceUpsertedCount = await repository.upsertContextItems(items);
      fetchedCount += items.length;
      upsertedCount += sourceUpsertedCount;
      syncedSourcesCount += 1;

      await repository.upsertSyncStates([
        {
          sourceId: source.id,
          userId: source.userId,
          syncStrategy: "polling",
          lastSuccessAt: startedAt,
          lastBackfillAt: input.mode === "backfill" ? startedAt : null,
        },
      ]);
      await repository.insertSyncRun({
        id: randomUUID(),
        sourceId: source.id,
        userId: source.userId,
        mode: input.mode ?? "incremental",
        status: "success",
        startedAt,
        finishedAt: new Date().toISOString(),
        fetchedCount: items.length,
        upsertedCount: sourceUpsertedCount,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown sync failure";
      failures.push({
        sourceId: source.id,
        message,
      });

      await repository.insertSyncRun({
        id: randomUUID(),
        sourceId: source.id,
        userId: source.userId,
        mode: input.mode ?? "incremental",
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        errorCode: "SYNC_FAILED",
        errorMessage: message,
      });
    }
  }

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "personal",
      "sync run",
      {
        mode: input.mode ?? "incremental",
        requested: input.all ? "all" : (input.source ?? "unknown"),
        sourcesDiscovered: knownSources.length,
        sourcesAttempted: targetSources.length,
        sourcesSynced: syncedSourcesCount,
        skippedSources: skippedSourcesCount,
        failedSources: failures.length,
        itemsFetched: fetchedCount,
        itemsUpserted: upsertedCount,
        sourcesRegistered: persistedSourceCount,
      },
      knownSources.length === 0
        ? {
            sources: {
              message: "当前还没有已连接的个人数据源",
              hint: "先完成 Composio 授权，再执行 `pin personal sync run --all --json`",
            },
          }
        : failures.length > 0
          ? {
              sync: {
                message: `有 ${failures.length} 个 source 同步失败`,
                hint: failures
                  .map((failure) => `${failure.sourceId}: ${failure.message}`)
                  .join(" | "),
              },
            }
          : undefined,
    ),
  };
};
