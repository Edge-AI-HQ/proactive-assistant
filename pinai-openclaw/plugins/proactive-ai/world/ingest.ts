/**
 * World data ingest module for the cloud proactive-ai plugin.
 *
 * Fetches RSS feeds from Google News, SEC, and Federal Reserve,
 * parses XML, normalises URLs, and upserts items via local SQLite.
 */
import { createHash } from 'node:crypto';
import { ingestWorldItem } from '../db.js';

// ── Default feed URLs ──

const DEFAULT_HEADLINES_URL_TEMPLATE =
  'https://news.google.com/rss/headlines/section/topic/{topic}?hl=en-US&gl=US&ceid=US:en';
const SEC_PRESS_RELEASES_URL = 'https://www.sec.gov/news/pressreleases.rss';
const FED_PRESS_RELEASES_URL = 'https://www.federalreserve.gov/feeds/press_all.xml';
const DEFAULT_SEC_USER_AGENT = 'PINAI World Fetch/1.0 (gray@pinai.io)';

const FEED_TIMEOUT_MS = 15_000;

// ── XML helpers (regex-based, matching standalone) ──

const stripCdata = (value: string): string =>
  value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripTags = (value: string): string => value.replace(/<[^>]*>/g, ' ');

const cleanText = (value?: string | null): string | null => {
  if (!value) return null;
  const cleaned = decodeEntities(stripTags(stripCdata(value)))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
};

const extractTag = (input: string, tag: string): string | null => {
  const match = input.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return cleanText(match?.[1] ?? null);
};

// ── Feed item types ──

interface ParsedFeedItem {
  provider: string;
  title: string;
  url: string;
  externalId?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
}

// ── Feed parsing ──

function parseNewsFeed(provider: string, xml: string): ParsedFeedItem[] {
  const itemMatches = Array.from(
    xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
  );

  return itemMatches
    .map<ParsedFeedItem | null>((match) => {
      const body = match[1];
      const title = extractTag(body, 'title');
      const url = extractTag(body, 'link');

      if (!title || !url) return null;

      return {
        provider,
        title,
        url,
        externalId: extractTag(body, 'guid') ?? null,
        summary: extractTag(body, 'description') ?? null,
        publishedAt: extractTag(body, 'pubDate') ?? null,
      };
    })
    .filter((item): item is ParsedFeedItem => item !== null);
}

// ── URL normalisation & ID generation ──

const UTM_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

function normalizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    // Remove UTM params
    for (const key of [...parsed.searchParams.keys()]) {
      if (UTM_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    // Lowercase hostname
    const result = parsed.toString().replace(
      parsed.hostname,
      parsed.hostname.toLowerCase(),
    );
    return result;
  } catch {
    return raw;
  }
}

function generateItemId(
  normalizedUrl: string,
  provider: string,
  title: string,
): string {
  return createHash('sha256')
    .update(`${normalizedUrl}|${provider}|${title}`)
    .digest('hex');
}

// ── Headline topic normalisation ──

function normalizeHeadlineTopic(topic?: string): string {
  const raw = (topic ?? 'general').trim().toLowerCase();
  if (raw === 'finance') return 'BUSINESS';
  if (raw === 'geopolitics') return 'WORLD';
  return 'WORLD';
}

// ── Feed request definitions ──

interface FeedRequest {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  topic?: string;
  streamType: 'headline' | 'search';
}

function buildGoogleNewsRequests(): FeedRequest[] {
  const template =
    process.env.PIN_WORLD_HEADLINES_URL_TEMPLATE || DEFAULT_HEADLINES_URL_TEMPLATE;

  return ['WORLD', 'BUSINESS'].map((topic) => ({
    provider: 'google-news',
    url: template.replaceAll('{topic}', encodeURIComponent(topic)),
    topic: topic.toLowerCase(),
    streamType: 'headline' as const,
  }));
}

function buildSecRequest(): FeedRequest {
  return {
    provider: 'sec',
    url: process.env.PIN_WORLD_SEC_SEARCH_URL_TEMPLATE || SEC_PRESS_RELEASES_URL,
    headers: {
      'user-agent':
        process.env.PIN_WORLD_SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT,
    },
    topic: 'finance',
    streamType: 'headline' as const,
  };
}

function buildFedRequest(): FeedRequest {
  return {
    provider: 'fed',
    url:
      process.env.PIN_WORLD_FED_SEARCH_URL_TEMPLATE || FED_PRESS_RELEASES_URL,
    topic: 'finance',
    streamType: 'headline' as const,
  };
}

// ── Single-provider fetch + ingest ──

interface ProviderResult {
  provider: string;
  fetched: number;
  ingested: number;
}

async function fetchAndIngestFeed(request: FeedRequest): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  let xml: string;
  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${request.provider}`);
    }
    xml = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const items = parseNewsFeed(request.provider, xml);
  let ingested = 0;

  const topic = request.topic ?? 'world';
  const normalizedTopic = normalizeHeadlineTopic(topic);
  const importance =
    topic === 'finance' || topic === 'geopolitics' ? 'high' : 'medium';

  for (const item of items) {
    const normalized = normalizeUrl(item.url);
    const _id = generateItemId(normalized, item.provider, item.title);

    try {
      await ingestWorldItem({
        provider: item.provider,
        streamType: request.streamType,
        title: item.title,
        url: item.url,
        normalizedUrl: normalized,
        externalId: item.externalId ?? undefined,
        summary: item.summary ?? undefined,
        publishedAt: item.publishedAt ?? undefined,
        searchQueries: [`headline:${normalizedTopic.toLowerCase()}`],
        topics: [normalizedTopic.toLowerCase()],
        regions: ['global'],
        importance,
        metadata: { sourceUrl: request.url, stream: 'headline' },
      });
      ingested++;
    } catch {
      // Skip individual item failures; continue with remaining items.
    }
  }

  return { provider: request.provider, fetched: items.length, ingested };
}

// ── Public API ──

const PROVIDER_BUILDERS: Record<string, () => FeedRequest[]> = {
  'google-news': buildGoogleNewsRequests,
  sec: () => [buildSecRequest()],
  fed: () => [buildFedRequest()],
};

const DEFAULT_PROVIDERS = ['google-news', 'sec', 'fed'];

/**
 * Fetch world headlines from the given providers and ingest into local DB.
 *
 * Each provider is fetched independently — one failing does not block others.
 */
export async function fetchWorldHeadlines(
  providers?: string[],
): Promise<ProviderResult[]> {
  const activeProviders = providers ?? DEFAULT_PROVIDERS;
  const results: ProviderResult[] = [];

  for (const name of activeProviders) {
    const builder = PROVIDER_BUILDERS[name];
    if (!builder) continue;

    const requests = builder();
    for (const request of requests) {
      try {
        const result = await fetchAndIngestFeed(request);
        results.push(result);
      } catch {
        // Provider failed entirely — record zero and continue.
        results.push({ provider: name, fetched: 0, ingested: 0 });
      }
    }
  }

  return results;
}
