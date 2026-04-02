import { randomUUID } from "node:crypto";

import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import {
  createPersonalEmbeddingProvider,
  type PersonalEmbeddingProvider,
} from "./embedding.js";
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
  type PersonalSemanticIndexCandidateRecord,
  type PersonalSearchResultRecord,
  type PersonalSyncRunRecord,
  type PersonalSyncStateRecord,
} from "./repository.js";
import {
  createPersonalSemanticIndex,
  type PersonalSemanticIndex,
  type PersonalSemanticIndexRecord,
  type PersonalSemanticSearchHit,
} from "./semantic_index.js";
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

const toSemanticIndexRecord = (
  row: PersonalSemanticIndexCandidateRecord,
  vector: number[],
): PersonalSemanticIndexRecord => ({
  id: row.id,
  userId: row.userId,
  sourceId: row.sourceId,
  toolkit: row.toolkit,
  itemType: row.itemType,
  occurredAt: row.occurredAt,
  title: row.title,
  url: row.url,
  attributesJson: row.attributesJson,
  searchText: row.searchText,
  vector,
});

const normalizeSnippet = (text: string | null): string | null =>
  text ? text.slice(0, 280) : null;

const toProviderUnavailableResult = (
  command: "index refresh" | "search",
  message: string,
  hint: string,
): RunCliResult => ({
  exitCode: 1,
  stdout: errorEnvelope(
    "personal",
    command,
    ErrorType.PROVIDER_UNAVAILABLE,
    "UNAVAILABLE",
    message,
    hint,
  ),
});

const toKeywordFallbackResult = (
  keywordResults: PersonalSearchResultRecord[],
  message: string,
  hint: string,
): RunCliResult => ({
  exitCode: 0,
  stdout: okEnvelope(
    "personal",
    "search",
    {
      strategy: "keyword",
      degraded: true,
      results: keywordResults.map(toSearchResult),
    },
    {
      search: {
        message,
        hint,
      },
    },
  ),
});

const toSemanticSearchResult = (
  row: PersonalContextItemRecord,
  score: number,
  matchReason: "semantic" | "hybrid",
): Record<string, unknown> => ({
  id: row.id,
  sourceId: row.sourceId,
  userId: row.userId,
  toolkit: row.toolkit,
  itemType: row.itemType,
  occurredAt: row.occurredAt,
  title: row.title,
  url: row.url,
  snippet: normalizeSnippet(row.contentText),
  score,
  matchReason,
  attributes: parseJsonObject(row.attributesJson),
});

const matchesQueryInput = (
  row: PersonalContextItemRecord,
  input: PersonalItemQueryInput,
): boolean => {
  if (row.isDeleted) {
    return false;
  }

  if (input.from && row.occurredAt && row.occurredAt < input.from) {
    return false;
  }
  if (input.to && row.occurredAt && row.occurredAt > input.to) {
    return false;
  }
  if (input.sourceIds && input.sourceIds.length > 0 && !input.sourceIds.includes(row.sourceId)) {
    return false;
  }
  if (input.toolkits && input.toolkits.length > 0 && !input.toolkits.includes(row.toolkit)) {
    return false;
  }
  if (input.itemTypes && input.itemTypes.length > 0 && !input.itemTypes.includes(row.itemType)) {
    return false;
  }
  if (input.facet) {
    const attributes = parseJsonObject(row.attributesJson);
    const facetValue = attributes[input.facet.key];
    if (String(facetValue ?? "") !== input.facet.value) {
      return false;
    }
  }

  return true;
};

const reciprocalRankFusion = (
  keywordRows: PersonalSearchResultRecord[],
  semanticRows: Array<{ row: PersonalContextItemRecord; score: number }>,
): Array<{ id: string; score: number; reason: "keyword" | "semantic" | "hybrid" }> => {
  const scores = new Map<string, { score: number; sources: Set<string> }>();
  const k = 60;

  keywordRows.forEach((row, index) => {
    const current = scores.get(row.id) ?? { score: 0, sources: new Set<string>() };
    current.score += 1 / (k + index + 1);
    current.sources.add("keyword");
    scores.set(row.id, current);
  });

  semanticRows.forEach(({ row }, index) => {
    const current = scores.get(row.id) ?? { score: 0, sources: new Set<string>() };
    current.score += 1 / (k + index + 1);
    current.sources.add("semantic");
    scores.set(row.id, current);
  });

  return [...scores.entries()]
    .map(([id, value]) => ({
      id,
      score: value.score,
      reason:
        value.sources.size === 2
          ? "hybrid"
          : (value.sources.has("semantic") ? "semantic" : "keyword"),
    }) as { id: string; score: number; reason: "keyword" | "semantic" | "hybrid" })
    .sort((a, b) => b.score - a.score);
};

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

export const runPersonalIndexRefresh = async (
  runtime: CliRuntimeInput,
  input: { all?: boolean; pending?: boolean; limit?: string | number },
  deps?: {
    embeddingProvider?: PersonalEmbeddingProvider;
    semanticIndex?: PersonalSemanticIndex;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const embeddingProvider = createPersonalEmbeddingProvider(
    runtime,
    deps?.embeddingProvider,
  );
  const semanticIndex = createPersonalSemanticIndex(runtime, deps?.semanticIndex);
  const limit =
    typeof input.limit === "number"
      ? input.limit
      : Number.parseInt(input.limit ?? "", 10) || 100;
  const mode = input.all ? "all" : "pending";
  const candidates = await repository.listSemanticIndexCandidates({
    all: input.all === true,
    limit,
  });

  if (candidates.length === 0) {
    return {
      exitCode: 0,
      stdout: okEnvelope(
        "personal",
        "index refresh",
        {
          mode,
          itemsSelected: 0,
          itemsIndexed: 0,
          deletedCount: 0,
        },
      ),
    };
  }

  try {
    const vectors = await embeddingProvider.embedTexts(
      candidates.map((candidate) => candidate.searchText),
    );
    const refreshResult = await semanticIndex.refresh(
      candidates.map((candidate, index) =>
        toSemanticIndexRecord(candidate, vectors[index] ?? []),
      ),
      { replaceAll: input.all === true },
    );
    const indexedAt = new Date().toISOString();
    await repository.markSemanticIndexed(
      candidates.map((candidate) => ({
        id: candidate.id,
        semanticIndexedAt: indexedAt,
        semanticModel: embeddingProvider.model,
        semanticContentHash: candidate.contentHash,
      })),
    );

    return {
      exitCode: 0,
      stdout: okEnvelope(
        "personal",
        "index refresh",
        {
          mode,
          itemsSelected: candidates.length,
          itemsIndexed: refreshResult.upsertedCount,
          deletedCount: refreshResult.deletedCount,
          model: embeddingProvider.model,
        },
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "语义索引提供方当前不可用";
    return toProviderUnavailableResult(
      "index refresh",
      "语义索引构建失败",
      `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
    );
  }
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
  deps?: {
    embeddingProvider?: PersonalEmbeddingProvider;
    semanticIndex?: PersonalSemanticIndex;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const queryInput = toItemQueryInput(input);
  const strategy = input.strategy ?? "keyword";
  const limit = queryInput.limit ?? 10;
  const keywordResults = await repository.searchItems(input.query, queryInput);

  if (strategy === "keyword") {
    return {
      exitCode: 0,
      stdout: okEnvelope(
        "personal",
        "search",
        {
          strategy,
          degraded: false,
          results: keywordResults.map(toSearchResult),
        },
      ),
    };
  }

  const embeddingProvider = createPersonalEmbeddingProvider(
    runtime,
    deps?.embeddingProvider,
  );
  const semanticIndex = createPersonalSemanticIndex(runtime, deps?.semanticIndex);
  const semanticReady = await semanticIndex.isReady();

  if (!semanticReady) {
    if (strategy === "semantic") {
      return toProviderUnavailableResult(
        "search",
        "语义索引尚未准备好",
        "先执行 `pin personal index refresh --all --json` 建立语义索引",
      );
    }

    return toKeywordFallbackResult(
      keywordResults,
      "语义索引尚未接入，当前已降级为关键词检索",
      "先执行 `pin personal index refresh --all --json` 建立语义索引",
    );
  }

  let semanticItems: Array<{ row: PersonalContextItemRecord; score: number }> = [];
  try {
    const queryVector = (await embeddingProvider.embedTexts([input.query]))[0] ?? [];
    const semanticHits = await semanticIndex.search(queryVector, {
      limit: Math.max(limit * 3, 20),
    });
    semanticItems = (await repository.listItemsByIds(semanticHits.map((hit) => hit.id)))
      .filter((row) => matchesQueryInput(row, queryInput))
      .map((row) => ({
        row,
        score: semanticHits.find((hit) => hit.id === row.id)?.score ?? 0,
      }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "语义检索提供方当前不可用";

    if (strategy === "semantic") {
      return toProviderUnavailableResult(
        "search",
        "语义检索当前不可用",
        `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
      );
    }

    return toKeywordFallbackResult(
      keywordResults,
      "语义检索当前不可用，已降级为关键词检索",
      `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
    );
  }

  if (strategy === "semantic") {
    return {
      exitCode: 0,
      stdout: okEnvelope(
        "personal",
        "search",
        {
          strategy: "semantic",
          degraded: false,
          results: semanticItems
            .slice(0, limit)
            .map(({ row, score }) => toSemanticSearchResult(row, score, "semantic")),
        },
      ),
    };
  }

  const fused = reciprocalRankFusion(keywordResults, semanticItems).slice(0, limit);
  const semanticMap = new Map(semanticItems.map((item) => [item.row.id, item]));
  const keywordMap = new Map(keywordResults.map((row) => [row.id, row]));

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "personal",
      "search",
      {
        strategy: "hybrid",
        degraded: false,
        results: fused.map((item) => {
          const semantic = semanticMap.get(item.id);
          if (semantic) {
            return toSemanticSearchResult(
              semantic.row,
              item.score,
              item.reason === "keyword" ? "semantic" : item.reason,
            );
          }

          const keyword = keywordMap.get(item.id);
          return keyword ? { ...toSearchResult(keyword), matchReason: item.reason } : null;
        }).filter((item): item is Record<string, unknown> => item !== null),
      },
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
