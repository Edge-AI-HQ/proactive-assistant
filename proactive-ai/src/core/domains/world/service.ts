import { PinDatabaseManager } from "../../db/database.js";
import { resolveAppRootFromCtx } from "../../paths.js";
import type { CoreContext } from "../../context.js";
import { NotFoundError, ProviderUnavailableError } from "../../errors.js";
import { parseOptionalInt } from "../../validation.js";
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
const SEC_PRESS_RELEASES_URL = "https://www.sec.gov/news/pressreleases.rss";
const FED_PRESS_RELEASES_URL = "https://www.federalreserve.gov/feeds/press_all.xml";
const DEFAULT_SEC_USER_AGENT = "PINAI World Fetch/1.0 (gray@pinai.io)";

interface WorldFeedRequest {
  url: string;
  provider: string;
  streamType: "search" | "headline";
  headers?: Record<string, string>;
}

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

const filterParsedFeedItems = (
  items: ParsedFeedItem[],
  input: { provider: string; query?: string },
): ParsedFeedItem[] => {
  if (input.provider === "google-news" || !input.query?.trim()) {
    return items;
  }

  const needle = input.query.trim().toLowerCase();
  return items.filter((item) => {
    const haystack = `${item.title} ${item.summary ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
};

const createRepository = async (ctx: CoreContext) => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new WorldRepository(manager.open("pin"));
};

const createProfileRepository = async (ctx: CoreContext) => {
  const dataRoot = resolveAppRootFromCtx(ctx);
  const manager = new PinDatabaseManager(dataRoot);
  await manager.init();
  return new ProfileRepository(manager.open("pin"));
};

const normalizeHeadlineTopic = (topic?: string): string => {
  const raw = (topic ?? "general").trim().toLowerCase();
  if (raw === "finance") return "BUSINESS";
  if (raw === "geopolitics") return "WORLD";
  return "WORLD";
};

const buildSearchUrl = (ctx: CoreContext, query: string): string => {
  const template =
    ctx.env.PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE ||
    DEFAULT_NEWS_SEARCH_URL_TEMPLATE;

  if (!template.includes("{query}")) {
    return template;
  }

  return template.replaceAll("{query}", encodeURIComponent(query.trim()));
};

const buildSearchRequest = (
  ctx: CoreContext,
  input: { query: string; provider?: string },
): WorldFeedRequest => {
  const provider = (input.provider ?? "google-news").trim().toLowerCase();

  if (provider === "sec") {
    return {
      provider,
      streamType: "search",
      url: ctx.env.PIN_WORLD_SEC_SEARCH_URL_TEMPLATE || SEC_PRESS_RELEASES_URL,
      headers: {
        "user-agent": ctx.env.PIN_WORLD_SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT,
      },
    };
  }

  if (provider === "fed") {
    return {
      provider,
      streamType: "search",
      url: ctx.env.PIN_WORLD_FED_SEARCH_URL_TEMPLATE || FED_PRESS_RELEASES_URL,
    };
  }

  return {
    provider,
    streamType: "search",
    url: buildSearchUrl(ctx, input.query),
  };
};

const buildHeadlinesUrl = (
  ctx: CoreContext,
  input: { topic?: string; region?: string },
): string => {
  const template =
    ctx.env.PIN_WORLD_HEADLINES_URL_TEMPLATE ||
    DEFAULT_HEADLINES_URL_TEMPLATE;

  return template
    .replaceAll("{topic}", encodeURIComponent(normalizeHeadlineTopic(input.topic)))
    .replaceAll("{region}", encodeURIComponent((input.region ?? "global").trim()));
};

const buildHeadlinesRequest = (
  ctx: CoreContext,
  input: { topic?: string; region?: string; provider?: string },
): WorldFeedRequest => {
  const provider = (input.provider ?? "google-news").trim().toLowerCase();

  if (provider === "sec") {
    return {
      provider,
      streamType: "headline",
      url: ctx.env.PIN_WORLD_SEC_HEADLINES_URL_TEMPLATE || SEC_PRESS_RELEASES_URL,
      headers: {
        "user-agent": ctx.env.PIN_WORLD_SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT,
      },
    };
  }

  if (provider === "fed") {
    return {
      provider,
      streamType: "headline",
      url: ctx.env.PIN_WORLD_FED_HEADLINES_URL_TEMPLATE || FED_PRESS_RELEASES_URL,
    };
  }

  return {
    provider,
    streamType: "headline",
    url: buildHeadlinesUrl(ctx, input),
  };
};

const fetchFeedResponse = async (request: WorldFeedRequest): Promise<Response> =>
  fetch(request.url, request.headers ? { headers: request.headers } : undefined);

const sortWorldItems = (items: WorldItemRecord[], limit: number): WorldItemRecord[] =>
  Array.from(new Map(items.map((item) => [item.id, item])).values())
    .sort((left, right) => {
      const leftTs = left.publishedAt ?? left.updatedAt;
      const rightTs = right.publishedAt ?? right.updatedAt;
      return rightTs.localeCompare(leftTs);
    })
    .slice(0, limit);

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

// ── Public service functions ──

export interface WorldSearchNotice {
  message: string;
  hint: string;
}

export const searchNews = async (
  ctx: CoreContext,
  input: { query: string; limit?: string; provider?: string; full?: boolean },
): Promise<{
  query: string;
  provider: string;
  count: number;
  items: Array<Record<string, unknown> | WorldItemRecord>;
}> => {
  const limit = parseOptionalInt(input.limit, 10);
  const request = buildSearchRequest(ctx, input);
  const provider = request.provider;
  let response: Response;

  try {
    response = await fetchFeedResponse(request);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown provider fetch error";
    throw new ProviderUnavailableError(
      "PROVIDER_UNAVAILABLE",
      `News search request failed: ${message}`,
      "check provider connectivity or try a different source",
    );
  }

  if (!response.ok) {
    throw new ProviderUnavailableError(
      "PROVIDER_UNAVAILABLE",
      `News search failed with status ${response.status}`,
      "check provider connectivity or try a different source",
    );
  }

  const repository = await createRepository(ctx);
  const xml = await response.text();
  const parsedItems = filterParsedFeedItems(parseNewsFeed(provider, xml), {
    provider,
    query: input.query,
  });

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
          sourceUrl: request.url,
        },
      }),
    );
  }

  const deduped = sortWorldItems(ingested, limit);

  return {
    query: input.query,
    provider,
    count: deduped.length,
    items: input.full === true ? deduped : deduped.map((item) => toSimpleWorldItem(item)),
  };
};

export const fetchHeadlines = async (
  ctx: CoreContext,
  input: { topic?: string; region?: string; limit?: string; provider?: string; full?: boolean },
): Promise<{
  topic: string;
  region: string;
  provider: string;
  count: number;
  items: Array<Record<string, unknown> | WorldItemRecord>;
}> => {
  const limit = parseOptionalInt(input.limit, 10);
  const request = buildHeadlinesRequest(ctx, input);
  const provider = request.provider;
  const topic = (input.topic ?? "general").trim().toLowerCase();
  const region = (input.region ?? "global").trim().toLowerCase();
  let response: Response;

  try {
    response = await fetchFeedResponse(request);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown provider fetch error";
    throw new ProviderUnavailableError(
      "PROVIDER_UNAVAILABLE",
      `Headline request failed: ${message}`,
      "check provider connectivity or try a different source",
    );
  }

  if (!response.ok) {
    throw new ProviderUnavailableError(
      "PROVIDER_UNAVAILABLE",
      `Headline fetch failed with status ${response.status}`,
      "check provider connectivity or try a different source",
    );
  }

  const repository = await createRepository(ctx);
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
          sourceUrl: request.url,
          stream: "headline",
        },
      }),
    );
  }

  const deduped = sortWorldItems(ingested, limit);

  return {
    topic,
    region,
    provider,
    count: deduped.length,
    items: input.full === true ? deduped : deduped.map((item) => toSimpleWorldItem(item)),
  };
};

export const runWorldIndexRefresh = async (
  ctx: CoreContext,
  input: { all?: boolean; limit?: string | number },
  deps?: {
    embeddingProvider?: WorldEmbeddingProvider;
    semanticIndex?: WorldSemanticIndex;
  },
): Promise<{
  mode: string;
  itemsSelected: number;
  itemsIndexed: number;
  deletedCount: number;
  model?: string;
}> => {
  const repository = await createRepository(ctx);
  const embeddingProvider = createWorldEmbeddingProvider(
    ctx,
    deps?.embeddingProvider,
  );
  const semanticIndex = createWorldSemanticIndex(ctx, deps?.semanticIndex);
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
      mode: input.all ? "all" : "recent",
      itemsSelected: 0,
      itemsIndexed: 0,
      deletedCount: 0,
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
      mode: input.all ? "all" : "recent",
      itemsSelected: candidates.length,
      itemsIndexed: refreshResult.upsertedCount,
      deletedCount: refreshResult.deletedCount,
      model: embeddingProvider.model,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "semantic index provider unavailable";
    throw new ProviderUnavailableError(
      "UNAVAILABLE",
      "世界信息语义索引构建失败",
      `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
    );
  }
};

export const searchWorldItems = async (
  ctx: CoreContext,
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
): Promise<{
  strategy: string;
  degraded: boolean;
  results: Array<Record<string, unknown>>;
  notice?: WorldSearchNotice;
}> => {
  const repository = await createRepository(ctx);
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
      strategy: "keyword",
      degraded: false,
      results: keywordResults.map((row) => toWorldSearchResult(row)),
    };
  }

  const embeddingProvider = createWorldEmbeddingProvider(
    ctx,
    deps?.embeddingProvider,
  );
  const semanticIndex = createWorldSemanticIndex(ctx, deps?.semanticIndex);
  let semanticReady = false;

  try {
    semanticReady = await semanticIndex.isReady();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "semantic provider unavailable";

    if (strategy === "semantic") {
      throw new ProviderUnavailableError(
        "UNAVAILABLE",
        "世界信息语义检索当前不可用",
        `请检查 OPENAI_API_KEY、LanceDB 依赖和 embedding 服务状态。底层错误: ${message}`,
      );
    }

    return {
      strategy: "keyword",
      degraded: true,
      results: keywordResults.map((row) => toWorldSearchResult(row)),
      notice: {
        message: "世界信息语义检索当前不可用，已降级为关键词检索",
        hint: `请检查 OPENAI_API_KEY、LanceDB 依赖和 embedding 服务状态。底层错误: ${message}`,
      },
    };
  }

  if (!semanticReady) {
    if (strategy === "semantic") {
      throw new ProviderUnavailableError(
        "UNAVAILABLE",
        "世界信息语义索引尚未准备好",
        "先执行 `pin world index refresh --all --json` 建立语义索引",
      );
    }

    return {
      strategy: "keyword",
      degraded: true,
      results: keywordResults.map((row) => toWorldSearchResult(row)),
      notice: {
        message: "语义索引尚未接入，当前已降级为关键词检索",
        hint: "先执行 `pin world index refresh --all --json` 建立语义索引",
      },
    };
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
      throw new ProviderUnavailableError(
        "UNAVAILABLE",
        "世界信息语义检索当前不可用",
        `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
      );
    }

    return {
      strategy: "keyword",
      degraded: true,
      results: keywordResults.map((row) => toWorldSearchResult(row)),
      notice: {
        message: "世界信息语义检索当前不可用，已降级为关键词检索",
        hint: `请检查 OPENAI_API_KEY 和 embedding 服务状态。底层错误: ${message}`,
      },
    };
  }

  if (strategy === "semantic") {
    return {
      strategy: "semantic",
      degraded: false,
      results: semanticItems
        .slice(0, limit)
        .map(({ row, score }) =>
          toWorldSearchResult(row, score, "semantic"),
        ),
    };
  }

  const fused = reciprocalRankFusion(keywordResults, semanticItems).slice(0, limit);
  const semanticMap = new Map(semanticItems.map((item) => [item.row.id, item]));
  const keywordMap = new Map(keywordResults.map((row) => [row.id, row]));

  return {
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
  };
};

export const listWorldItems = async (
  ctx: CoreContext,
  input: {
    limit?: string;
    query?: string;
    since?: string;
    until?: string;
    afterId?: string;
    afterUpdatedAt?: string;
    full?: boolean;
  },
): Promise<Array<Record<string, unknown> | WorldItemRecord>> => {
  const repository = await createRepository(ctx);
  const limit = parseOptionalInt(input.limit, 20);
  const items = await repository.list({
    limit,
    query: input.query,
    since: input.since,
    until: input.until,
    afterId: input.afterId,
    afterUpdatedAt: input.afterUpdatedAt,
  });

  return input.full ? items : items.map((item) => toSimpleWorldItem(item));
};

export const getWorldItem = async (
  ctx: CoreContext,
  id: string,
  full = false,
): Promise<Record<string, unknown> | WorldItemRecord> => {
  const repository = await createRepository(ctx);
  const item = await repository.getById(id);

  if (!item) {
    throw new NotFoundError(
      "NOT_FOUND",
      `World item ${id} not found`,
    );
  }

  return full ? item : toSimpleWorldItem(item);
};

export const shortlistWorldItems = async (
  ctx: CoreContext,
  input: {
    profileId: string;
    limit?: string;
  },
): Promise<Array<Record<string, unknown>>> => {
  const profileRepository = await createProfileRepository(ctx);
  const profile = await profileRepository.getById(input.profileId);
  if (!profile) {
    throw new NotFoundError(
      "NOT_FOUND",
      `Profile ${input.profileId} not found`,
      "run `pin profile list` to see available profiles",
    );
  }

  const repository = await createRepository(ctx);
  const interests = await profileRepository.listInterests(input.profileId, {
    limit: 100,
  });
  const limit = parseOptionalInt(input.limit, 20);
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

  return shortlisted;
};

export const buildWorldContext = async (
  ctx: CoreContext,
  input: {
    ids: string;
    full?: boolean;
  },
): Promise<Array<Record<string, unknown> | WorldItemRecord>> => {
  const repository = await createRepository(ctx);
  const ids = input.ids
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const items = await repository.listByIds(ids);

  return input.full ? items : items.map((item) => toSimpleWorldItem(item));
};
