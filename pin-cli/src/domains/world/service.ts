import { PinDatabaseManager } from "../../db/database.js";
import { errorEnvelope, okEnvelope } from "../../output/envelope.js";
import { ErrorType } from "../../output/errors.js";
import type { CliRuntimeInput, RunCliResult } from "../../runtime.js";
import { WorldRepository } from "./repository.js";
import type { WorldItemRecord } from "./schema.js";

const DEFAULT_NEWS_SEARCH_URL_TEMPLATE =
  "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en";

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

const buildSearchUrl = (runtime: CliRuntimeInput, query: string): string => {
  const template =
    runtime.env.PIN_WORLD_NEWS_SEARCH_URL_TEMPLATE ||
    DEFAULT_NEWS_SEARCH_URL_TEMPLATE;

  if (!template.includes("{query}")) {
    return template;
  }

  return template.replaceAll("{query}", encodeURIComponent(query.trim()));
};

export const searchNews = async (
  runtime: CliRuntimeInput,
  input: { query: string; limit?: string; provider?: string },
) => {
  const limit = Number.parseInt(input.limit ?? "10", 10);
  const provider = input.provider ?? "google-news";
  const url = buildSearchUrl(runtime, input.query);
  const response = await fetch(url);

  if (!response.ok) {
    return {
      exitCode: 1,
      stdout: errorEnvelope(
        "world",
        "search",
        ErrorType.PROVIDER_UNAVAILABLE,
        "UPSTREAM_ERROR",
        `News search failed with status ${response.status}`,
        "check provider availability or try a different source",
      ),
    } satisfies RunCliResult;
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

  const deduped = Array.from(new Map(ingested.map((item) => [item.id, item])).values())
    .sort((left, right) => {
      const leftTs = left.publishedAt ?? left.updatedAt;
      const rightTs = right.publishedAt ?? right.updatedAt;
      return rightTs.localeCompare(leftTs);
    })
    .slice(0, limit);

  return {
    exitCode: 0,
    stdout: okEnvelope("world", "search", {
      query: input.query,
      provider,
      count: deduped.length,
      items: deduped,
    }),
  } satisfies RunCliResult;
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
    stdout: okEnvelope("world", "list", items),
  } satisfies RunCliResult;
};

export const getWorldItem = async (
  runtime: CliRuntimeInput,
  id: string,
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
    stdout: okEnvelope("world", "get", item),
  } satisfies RunCliResult;
};
