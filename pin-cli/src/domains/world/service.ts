import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import {
  createWorldEmbeddingProvider,
  type WorldEmbeddingProvider,
} from "./embedding.js";
import { WorldRepository } from "./repository.js";
import type { WorldItemRecord } from "./schema.js";
import { ProfileRepository, type ProfileInterestRecord } from "../profile/repository.js";
import {
  createWorldSemanticIndex,
  type WorldSemanticIndex,
  type WorldSemanticIndexRecord,
} from "./semantic_index.js";

const DEFAULT_NEWS_SEARCH_URL_TEMPLATE =
  "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en";
const DEFAULT_HEADLINES_URL_TEMPLATE =
  "https://news.google.com/rss/headlines/section/topic/{topic}?hl=en-US&gl=US&ceid=US:en";

interface ParsedFeedItem {
  provider: string;
  title: string;
  url: string;
  externalId?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
}

const stripCdata = (value: string): string =>
  value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripTags = (value: string): string => value.replace(/<[^>]*>/g, " ");

const cleanText = (value?: string | null): string | null => {
  if (!value) return null;
  const cleaned = decodeEntities(stripTags(stripCdata(value))).replace(/\s+/g, " ").trim();
  return cleaned || null;
};

const extractTag = (input: string, tag: string): string | null => {
  const match = input.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return cleanText(match?.[1] ?? null);
};

const parseNewsFeed = (provider: string, xml: string): ParsedFeedItem[] => {
  const itemMatches = Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi));

  return itemMatches
    .map<ParsedFeedItem | null>((match) => {
      const body = match[1];
      const title = extractTag(body, "title");
      const url = extractTag(body, "link");

      if (!title || !url) {
        return null;
      }

      return {
        provider,
        title,
        url,
        externalId: extractTag(body, "guid") ?? null,
        summary: extractTag(body, "description") ?? null,
        publishedAt: extractTag(body, "pubDate") ?? null,
      } satisfies ParsedFeedItem;
    })
    .filter((item): item is ParsedFeedItem => item !== null);
};

const createRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new WorldRepository(manager.open("pin"));
};

const createProfileRepository = async (runtime: CliRuntimeInput) => {
  const dataRoot = runtime.env.PIN_DATA_ROOT || `${runtime.homeDir}/.pin`;
  const manager = new PinDatabaseManager({ dataRoot });
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
};

const normalizeHeadlineTopic = (topic?: string): string => {
  const raw = (topic ?? "general").trim().toLowerCase();
  if (raw === "finance") return "BUSINESS";
  if (raw === "geopolitics") return "WORLD";
  return "WORLD";
};

const buildSearchUrl = (runtime: CliRuntimeInput, query: string): string => {
  const template =
    runtime.env.PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE ||
    DEFAULT_NEWS_SEARCH_URL_TEMPLATE;

  if (!template.includes("{query}")) {
    return template;
  }

  return template.replaceAll("{query}", encodeURIComponent(query.trim()));
};

const buildHeadlinesUrl = (
  runtime: CliRuntimeInput,
  input: { topic?: string; region?: string },
): string => {
  const template =
    runtime.env.PIN_WORLD_HEADLINES_URL_TEMPLATE ||
    DEFAULT_HEADLINES_URL_TEMPLATE;

  return template
    .replaceAll("{topic}", encodeURIComponent(normalizeHeadlineTopic(input.topic)))
    .replaceAll("{region}", encodeURIComponent((input.region ?? "global").trim()));
};

const sortWorldItems = (items: WorldItemRecord[], limit: number): WorldItemRecord[] =>
  Array.from(new Map(items.map((item) => [item.id, item])).values())
    .sort((left, right) => {
      const leftTs = left.publishedAt ?? left.updatedAt;
      const rightTs = right.publishedAt ?? right.updatedAt;
      return rightTs.localeCompare(leftTs);
    })
    .slice(0, limit);

const providerErrorResult = (
  command: "search" | "headlines",
  message: string,
  hint = "check provider connectivity or try a different source",
): RunCliResult => ({
  exitCode: 1,
  stdout: errorEnvelope(
    "world",
    command,
    ErrorType.PROVIDER_UNAVAILABLE,
    "PROVIDER_UNAVAILABLE",
    message,
    hint,
  ),
});

const worldSearchUnavailable = (
  command: "index refresh" | "find",
  message: string,
  hint: string,
): RunCliResult => ({
  exitCode: 1,
  stdout: errorEnvelope(
    "world",
    command,
    ErrorType.PROVIDER_UNAVAILABLE,
    "UNAVAILABLE",
    message,
    hint,
  ),
});

const worldKeywordFallback = (
  results: Array<Record<string, unknown>>,
  message: string,
  hint: string,
): RunCliResult => ({
  exitCode: 0,
  stdout: okEnvelope(
    "world",
    "find",
    {
      strategy: "keyword",
      degraded: true,
      results,
    },
    {
      search: {
        message,
        hint,
      },
    },
  ),
});

const toSemanticIndexRecord = (
  row: {
    id: string;
    provider: string;
    streamType: string;
    publishedAt: string | null;
    title: string;
    url: string;
    summary: string | null;
    topics: string[];
    regions: string[];
    importance: string | null;
    searchText: string;
  },
  vector: number[],
): WorldSemanticIndexRecord => ({
  id: row.id,
  provider: row.provider,
  streamType: row.streamType,
  publishedAt: row.publishedAt,
  title: row.title,
  url: row.url,
  summary: row.summary,
  topicsJson: JSON.stringify(row.topics ?? []),
  regionsJson: JSON.stringify(row.regions ?? []),
  importance: row.importance ?? null,
  searchText: row.searchText,
  vector,
});

const toWorldSearchResult = (
  row: WorldItemRecord,
  score?: number | null,
  matchReason: "keyword" | "semantic" | "hybrid" = "keyword",
): Record<string, unknown> => ({
  id: row.id,
  provider: row.provider,
  streamType: row.streamType,
  title: row.title,
  url: row.url,
  summary: row.summary,
  publishedAt: row.publishedAt,
  topics: row.topics ?? [],
  regions: row.regions ?? [],
  importance: row.importance ?? null,
  searchQueries: row.searchQueries ?? [],
  score,
  matchReason,
});

const toSimpleWorldItem = (item: WorldItemRecord): Record<string, unknown> => ({
  id: item.id,
  title: item.title,
  summary: item.summary ?? null,
  topics: item.topics ?? [],
  importance: item.importance ?? null,
  publishedAt: item.publishedAt,
  provider: item.provider,
});

const getImportanceBoost = (importance?: string | null): number => {
  if (importance === "critical") return 0.6;
  if (importance === "high") return 0.4;
  if (importance === "medium") return 0.2;
  return 0;
};

const scoreWorldItemForProfile = (
  item: WorldItemRecord,
  interests: ProfileInterestRecord[],
): { profileScore: number; reasons: Array<{ code: string; value: string | number }> } => {
  const reasons: Array<{ code: string; value: string | number }> = [];
  let profileScore = getImportanceBoost(item.importance);

  if (item.importance) {
    reasons.push({ code: "IMPORTANCE", value: item.importance });
  }

  for (const interest of interests) {
    if (interest.kind !== "topic") {
      continue;
    }
    const matchesTopic = (item.topics ?? []).includes(interest.key);
    if (!matchesTopic) {
      continue;
    }
    profileScore += interest.score;
    reasons.push(
      interest.score >= 0
        ? { code: "TOPIC_MATCH", value: interest.key }
        : { code: "SUPPRESSED_TOPIC_MATCH", value: interest.key },
    );
  }

  return {
    profileScore: Number(profileScore.toFixed(4)),
    reasons,
  };
};

const reciprocalRankFusion = (
  keywordRows: WorldItemRecord[],
  semanticRows: Array<{ row: WorldItemRecord; score: number }>,
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

export const searchNews = async (
  runtime: CliRuntimeInput,
  input: { query: string; limit?: string; provider?: string; full?: boolean },
) => {
  const limit = Number.parseInt(input.limit ?? "10", 10);
  const provider = input.provider ?? "google-news";
  const url = buildSearchUrl(runtime, input.query);
  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown provider fetch error";
    return providerErrorResult(
      "search",
      `News search request failed: ${message}`,
    );
  }

  if (!response.ok) {
    return providerErrorResult(
      "search",
      `News search failed with status ${response.status}`,
    );
  }

  const repository = await createRepository(runtime);
  const xml = await response.text();
  const parsedItems = parseNewsFeed(provider, xml);

  const ingested: WorldItemRecord[] = [];
  for (const item of parsedItems) {
    ingested.push(
      await repository.ingest({
        provider: item.provider,
        title: item.title,
        url: item.url,
        externalId: item.externalId,
        summary: item.summary,
        publishedAt: item.publishedAt,
        query: input.query,
        metadata: {
          sourceUrl: url,
        },
      }),
    );
  }

  const deduped = sortWorldItems(ingested, limit);

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "search", {
      query: input.query,
      provider,
      count: deduped.length,
      items: input.full === true ? deduped : deduped.map((item) => toSimpleWorldItem(item)),
    }),
  } satisfies RunCliResult;
};

export const fetchHeadlines = async (
  runtime: CliRuntimeInput,
  input: { topic?: string; region?: string; limit?: string; provider?: string; full?: boolean },
) => {
  const limit = Number.parseInt(input.limit ?? "10", 10);
  const provider = input.provider ?? "google-news";
  const topic = (input.topic ?? "general").trim().toLowerCase();
  const region = (input.region ?? "global").trim().toLowerCase();
  const url = buildHeadlinesUrl(runtime, input);
  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown provider fetch error";
    return providerErrorResult(
      "headlines",
      `Headline request failed: ${message}`,
    );
  }

  if (!response.ok) {
    return providerErrorResult(
      "headlines",
      `Headline fetch failed with status ${response.status}`,
    );
  }

  const repository = await createRepository(runtime);
  const xml = await response.text();
  const parsedItems = parseNewsFeed(provider, xml);
  const streamQuery = `headline:${topic}:${region}`;

  const ingested: WorldItemRecord[] = [];
  for (const item of parsedItems) {
    ingested.push(
      await repository.ingest({
        provider: item.provider,
        streamType: "headline",
        title: item.title,
        url: item.url,
        externalId: item.externalId,
        summary: item.summary,
        publishedAt: item.publishedAt,
        query: streamQuery,
        topics: [topic],
        regions: [region],
        importance: topic === "geopolitics" || topic === "finance" ? "high" : "medium",
        metadata: {
          sourceUrl: url,
          stream: "headline",
        },
      }),
    );
  }

  const deduped = sortWorldItems(ingested, limit);

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "headlines", {
      topic,
      region,
      provider,
      count: deduped.length,
      items: input.full === true ? deduped : deduped.map((item) => toSimpleWorldItem(item)),
    }),
  } satisfies RunCliResult;
};

export const runWorldIndexRefresh = async (
  runtime: CliRuntimeInput,
  input: { all?: boolean; limit?: string | number },
  deps?: {
    embeddingProvider?: WorldEmbeddingProvider;
    semanticIndex?: WorldSemanticIndex;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const embeddingProvider = createWorldEmbeddingProvider(
    runtime,
    deps?.embeddingProvider,
  );
  const semanticIndex = createWorldSemanticIndex(runtime, deps?.semanticIndex);
  const limit =
    typeof input.limit === "number"
      ? input.limit
      : Number.parseInt(input.limit ?? "", 10) || 100;
  const candidates = await repository.listSemanticIndexCandidates({
    all: input.all === true,
    limit,
  });

  if (candidates.length === 0) {
    return {
      exitCode: 0,
      stdout: okEnvelope("world", "index refresh", {
        mode: input.all ? "all" : "recent",
        itemsSelected: 0,
        itemsIndexed: 0,
        deletedCount: 0,
      }),
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

    return {
      exitCode: 0,
      stdout: okEnvelope("world", "index refresh", {
        mode: input.all ? "all" : "recent",
        itemsSelected: candidates.length,
        itemsIndexed: refreshResult.upsertedCount,
        deletedCount: refreshResult.deletedCount,
        model: embeddingProvider.model,
      }),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "semantic index provider unavailable";
    return worldSearchUnavailable(
      "index refresh",
      "世界信息语义索引构建失败",
      `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
    );
  }
};

export const searchWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    query: string;
    strategy?: string;
    since?: string;
    until?: string;
    limit?: string | number;
  },
  deps?: {
    embeddingProvider?: WorldEmbeddingProvider;
    semanticIndex?: WorldSemanticIndex;
  },
): Promise<RunCliResult> => {
  const repository = await createRepository(runtime);
  const strategy = input.strategy ?? "keyword";
  const limit =
    typeof input.limit === "number"
      ? input.limit
      : Number.parseInt(input.limit ?? "", 10) || 10;
  const keywordResults = await repository.list({
    query: input.query,
    since: input.since,
    until: input.until,
    limit,
  });

  if (strategy === "keyword") {
    return {
      exitCode: 0,
      stdout: okEnvelope("world", "find", {
        strategy: "keyword",
        degraded: false,
        results: keywordResults.map((row) => toWorldSearchResult(row)),
      }),
    };
  }

  const embeddingProvider = createWorldEmbeddingProvider(
    runtime,
    deps?.embeddingProvider,
  );
  const semanticIndex = createWorldSemanticIndex(runtime, deps?.semanticIndex);
  let semanticReady = false;

  try {
    semanticReady = await semanticIndex.isReady();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "semantic provider unavailable";

    if (strategy === "semantic") {
      return worldSearchUnavailable(
        "find",
        "世界信息语义检索当前不可用",
        `请检查 OPENAI_API_KEY、LanceDB 依赖和 embedding 服务状态。底层错误: ${message}`,
      );
    }

    return worldKeywordFallback(
      keywordResults.map((row) => toWorldSearchResult(row)),
      "世界信息语义检索当前不可用，已降级为关键词检索",
      `请检查 OPENAI_API_KEY、LanceDB 依赖和 embedding 服务状态。底层错误: ${message}`,
    );
  }

  if (!semanticReady) {
    if (strategy === "semantic") {
      return worldSearchUnavailable(
        "find",
        "世界信息语义索引尚未准备好",
        "先执行 `pin world index refresh --all --json` 建立语义索引",
      );
    }

    return worldKeywordFallback(
      keywordResults.map((row) => toWorldSearchResult(row)),
      "语义索引尚未接入，当前已降级为关键词检索",
      "先执行 `pin world index refresh --all --json` 建立语义索引",
    );
  }

  let semanticItems: Array<{ row: WorldItemRecord; score: number }> = [];
  try {
    const queryVector = (await embeddingProvider.embedTexts([input.query]))[0] ?? [];
    const semanticHits = await semanticIndex.search(queryVector, {
      limit: Math.max(limit * 3, 20),
    });
    semanticItems = (await repository.listByIds(semanticHits.map((hit) => hit.id)))
      .filter((row) => {
        if (input.since && (row.publishedAt ?? row.updatedAt) < input.since) return false;
        if (input.until && (row.publishedAt ?? row.updatedAt) > input.until) return false;
        return true;
      })
      .map((row) => ({
        row,
        score: semanticHits.find((hit) => hit.id === row.id)?.score ?? 0,
      }));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "semantic provider unavailable";

    if (strategy === "semantic") {
      return worldSearchUnavailable(
        "find",
        "世界信息语义检索当前不可用",
        `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
      );
    }

    return worldKeywordFallback(
      keywordResults.map((row) => toWorldSearchResult(row)),
      "世界信息语义检索当前不可用，已降级为关键词检索",
      `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
    );
  }

  if (strategy === "semantic") {
    return {
      exitCode: 0,
      stdout: okEnvelope("world", "find", {
        strategy: "semantic",
        degraded: false,
        results: semanticItems
          .slice(0, limit)
          .map(({ row, score }) =>
            toWorldSearchResult(row, score, "semantic"),
          ),
      }),
    };
  }

  const fused = reciprocalRankFusion(keywordResults, semanticItems).slice(0, limit);
  const semanticMap = new Map(semanticItems.map((item) => [item.row.id, item]));
  const keywordMap = new Map(keywordResults.map((row) => [row.id, row]));

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "find", {
      strategy: "hybrid",
      degraded: false,
      results: fused
        .map((item) => {
          const semantic = semanticMap.get(item.id);
          if (semantic) {
            return toWorldSearchResult(
              semantic.row,
              item.score,
              item.reason === "keyword" ? "semantic" : item.reason,
            );
          }

          const keyword = keywordMap.get(item.id);
          return keyword
            ? toWorldSearchResult(keyword, item.score, item.reason)
            : null;
        })
        .filter((item): item is Record<string, unknown> => item !== null),
    }),
  };
};

export const listWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    limit?: string;
    query?: string;
    since?: string;
    until?: string;
    afterId?: string;
    afterUpdatedAt?: string;
    full?: boolean;
  },
) => {
  const repository = await createRepository(runtime);
  const limit = Number.parseInt(input.limit ?? "20", 10);
  const items = await repository.list({
    limit,
    query: input.query,
    since: input.since,
    until: input.until,
    afterId: input.afterId,
    afterUpdatedAt: input.afterUpdatedAt,
  });

  return {
    exitCode: 0,
    stdout: okEnvelope(
      "world",
      "list",
      input.full ? items : items.map((item) => toSimpleWorldItem(item)),
    ),
  } satisfies RunCliResult;
};

export const getWorldItem = async (
  runtime: CliRuntimeInput,
  id: string,
  full = false,
) => {
  const repository = await createRepository(runtime);
  const item = await repository.getById(id);

  if (!item) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "world",
        "get",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `World item ${id} not found`,
      ),
    } satisfies RunCliResult;
  }

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "get", full ? item : toSimpleWorldItem(item)),
  } satisfies RunCliResult;
};

export const shortlistWorldItems = async (
  runtime: CliRuntimeInput,
  input: {
    profileId: string;
    limit?: string;
  },
) => {
  const profileRepository = await createProfileRepository(runtime);
  const profile = await profileRepository.getById(input.profileId);
  if (!profile) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "world",
        "shortlist",
        ErrorType.NOT_FOUND,
        "NOT_FOUND",
        `Profile ${input.profileId} not found`,
        "run `pin profile list` to see available profiles",
      ),
    } satisfies RunCliResult;
  }

  const repository = await createRepository(runtime);
  const interests = await profileRepository.listInterests(input.profileId, {
    limit: 100,
  });
  const limit = Number.parseInt(input.limit ?? "20", 10);
  const items = await repository.list({
    limit: Math.max(Number.isNaN(limit) ? 20 : limit * 5, 20),
  });

  const shortlisted = items
    .map((item) => {
      const scored = scoreWorldItemForProfile(item, interests);
      return {
        id: item.id,
        title: item.title,
        summary: item.summary,
        topics: item.topics ?? [],
        importance: item.importance ?? null,
        publishedAt: item.publishedAt,
        profileScore: scored.profileScore,
        reasons: scored.reasons,
      };
    })
    .sort((left, right) => {
      const scoreDiff = right.profileScore - left.profileScore;
      if (scoreDiff !== 0) return scoreDiff;
      return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
    })
    .slice(0, Number.isNaN(limit) ? 20 : limit);

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "shortlist", shortlisted),
  } satisfies RunCliResult;
};

export const buildWorldContext = async (
  runtime: CliRuntimeInput,
  input: {
    ids: string;
    full?: boolean;
  },
) => {
  const repository = await createRepository(runtime);
  const ids = input.ids
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const items = await repository.listByIds(ids);
  const context = input.full ? items : items.map((item) => toSimpleWorldItem(item));

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "context", context),
  } satisfies RunCliResult;
};
