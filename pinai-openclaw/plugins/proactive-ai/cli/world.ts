import { parseArgs, success, failure } from './shared.js';
import * as db from '../db.js';
import { getWorldSemanticIndex } from '../world/semantic_index.js';
import { getWorldEmbeddingProvider } from '../world/embedding.js';
import type { WorldSemanticIndexRecord } from '../world/semantic_index.js';

// ── Helpers ──

const getImportanceBoost = (importance?: string | null): number => {
  if (importance === 'critical') return 0.6;
  if (importance === 'high') return 0.4;
  if (importance === 'medium') return 0.2;
  return 0;
};

function scoreWorldSignalForProfile(
  item: db.WorldSignalRow,
  interests: db.InterestRow[],
): { profileScore: number; reasons: Array<{ code: string; value: string | number }> } {
  const reasons: Array<{ code: string; value: string | number }> = [];
  let profileScore = getImportanceBoost(item.importance);

  if (item.importance) {
    reasons.push({ code: 'IMPORTANCE', value: item.importance });
  }

  for (const interest of interests) {
    if (interest.kind !== 'topic') continue;
    const matchesTopic = (item.topics ?? []).includes(interest.key);
    if (!matchesTopic) continue;
    profileScore += interest.score;
    reasons.push(
      interest.score >= 0
        ? { code: 'TOPIC_MATCH', value: interest.key }
        : { code: 'SUPPRESSED_TOPIC_MATCH', value: interest.key },
    );
  }

  return {
    profileScore: Number(profileScore.toFixed(4)),
    reasons,
  };
}

function reciprocalRankFusion(
  keywordRows: db.WorldSignalRow[],
  semanticRows: Array<{ row: db.WorldSignalRow; score: number }>,
): Array<{ id: string; score: number; reason: 'keyword' | 'semantic' | 'hybrid' }> {
  const scores = new Map<string, { score: number; sources: Set<string> }>();
  const k = 60;

  keywordRows.forEach((row, index) => {
    const current = scores.get(row.id) ?? { score: 0, sources: new Set<string>() };
    current.score += 1 / (k + index + 1);
    current.sources.add('keyword');
    scores.set(row.id, current);
  });

  semanticRows.forEach(({ row }, index) => {
    const current = scores.get(row.id) ?? { score: 0, sources: new Set<string>() };
    current.score += 1 / (k + index + 1);
    current.sources.add('semantic');
    scores.set(row.id, current);
  });

  return [...scores.entries()]
    .map(([id, value]) => ({
      id,
      score: value.score,
      reason: (value.sources.size === 2
        ? 'hybrid'
        : value.sources.has('semantic') ? 'semantic' : 'keyword') as 'keyword' | 'semantic' | 'hybrid',
    }))
    .sort((a, b) => b.score - a.score);
}

function toWorldSearchResult(
  row: db.WorldSignalRow,
  score?: number | null,
  matchReason: 'keyword' | 'semantic' | 'hybrid' = 'keyword',
): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    streamType: row.stream_type,
    title: row.title,
    url: row.url,
    summary: row.summary,
    publishedAt: row.published_at,
    topics: row.topics ?? [],
    regions: row.regions ?? [],
    importance: row.importance ?? null,
    searchQueries: row.search_queries ?? [],
    score,
    matchReason,
  };
}

function toSemanticIndexRecord(
  candidate: db.WorldSemanticCandidate,
  vector: number[],
): WorldSemanticIndexRecord {
  return {
    id: candidate.id,
    provider: candidate.provider,
    streamType: candidate.stream_type,
    publishedAt: candidate.published_at,
    title: candidate.title,
    url: candidate.url,
    summary: candidate.summary,
    topicsJson: JSON.stringify(candidate.topics ?? []),
    regionsJson: JSON.stringify(candidate.regions ?? []),
    importance: candidate.importance ?? null,
    searchText: candidate.searchText,
    vector,
  };
}

// ── Command handler ──

export async function handleWorld(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (sub === 'search') {
    const query = flags['query'];
    if (!query) return failure('world', 'search', 'validation', 'Missing --query');
    const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 20;
    const items = await db.listWorldSignals({ query, limit });
    return success('world', 'search', { query, count: items.length, items });
  }

  if (sub === 'headlines') {
    const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 20;
    const items = await db.listWorldSignals({ limit });
    return success('world', 'headlines', { count: items.length, items });
  }

  if (sub === 'find') {
    return handleFind(flags);
  }

  if (sub === 'list') {
    const items = await db.listWorldSignals({
      query: flags['query'],
      since: flags['since'],
      limit: flags['limit'] ? parseInt(flags['limit'], 10) : 20,
    });
    return success('world', 'list', { count: items.length, items });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('world', 'get', 'validation', 'Missing --id');
    const item = await db.getWorldSignal(flags['id']);
    if (!item) return failure('world', 'get', 'not_found', `World item ${flags['id']} not found`);
    return success('world', 'get', item);
  }

  if (sub === 'shortlist') {
    return handleShortlist(flags);
  }

  if (sub === 'context') {
    const ids = flags['ids']?.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids?.length) return failure('world', 'context', 'validation', 'Missing --ids');
    const items = await Promise.all(ids.map(id => db.getWorldSignal(id)));
    const found = items.filter(Boolean);
    return success('world', 'context', { requested: ids.length, found: found.length, items: found });
  }

  if (sub === 'index') {
    return handleIndex(positional.slice(1), flags);
  }

  return failure('world', sub ?? 'unknown', 'validation', `Unknown world command: ${sub}`, 'Available: search, headlines, find, list, get, shortlist, context, index');
}

// ── Index refresh ──

async function handleIndex(args: string[], flags: Record<string, string>): Promise<string> {
  const action = args[0];

  if (action === 'refresh') {
    const all = flags['all'] === 'true' || flags['all'] === '1';
    const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 100;

    const candidates = await db.listSemanticIndexCandidates({ limit });
    if (candidates.length === 0) {
      return success('world', 'index.refresh', {
        mode: all ? 'all' : 'recent',
        itemsSelected: 0,
        itemsIndexed: 0,
        deletedCount: 0,
      });
    }

    const embeddingProvider = getWorldEmbeddingProvider();
    const semanticIndex = getWorldSemanticIndex();

    try {
      const vectors = await embeddingProvider.embedTexts(
        candidates.map(c => c.searchText),
      );
      const records = candidates.map((c, i) =>
        toSemanticIndexRecord(c, vectors[i] ?? []),
      );
      const refreshResult = await semanticIndex.refresh(records, { replaceAll: all });

      return success('world', 'index.refresh', {
        mode: all ? 'all' : 'recent',
        itemsSelected: candidates.length,
        itemsIndexed: refreshResult.upsertedCount,
        deletedCount: refreshResult.deletedCount,
        model: embeddingProvider.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'embedding provider unavailable';
      return failure('world', 'index.refresh', 'provider_error',
        `Semantic index refresh failed: ${message}`,
        'Check OPENAI_API_KEY or LITELLM_API_KEY and embedding service status');
    }
  }

  // Default: status check
  const idx = getWorldSemanticIndex();
  const ready = await idx.isReady();
  return success('world', 'index.status', { ready, notice: 'Use `world index refresh` to populate the semantic index' });
}

// ── Hybrid search (find) ──

async function handleFind(flags: Record<string, string>): Promise<string> {
  const query = flags['query'];
  if (!query) return failure('world', 'find', 'validation', 'Missing --query');

  const strategy = flags['strategy'] ?? 'keyword';
  const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 10;

  // Keyword search (always needed for keyword/hybrid)
  const keywordResults = await db.listWorldSignals({
    query,
    since: flags['since'],
    limit,
  });

  if (strategy === 'keyword') {
    return success('world', 'find', {
      query,
      strategy: 'keyword',
      degraded: false,
      count: keywordResults.length,
      results: keywordResults.map(r => toWorldSearchResult(r)),
    });
  }

  // Semantic / hybrid path
  const embeddingProvider = getWorldEmbeddingProvider();
  const semanticIndex = getWorldSemanticIndex();

  let semanticReady = false;
  try {
    semanticReady = await semanticIndex.isReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'semantic provider unavailable';
    if (strategy === 'semantic') {
      return failure('world', 'find', 'provider_error',
        `Semantic search unavailable: ${message}`,
        'Check OPENAI_API_KEY and run `world index refresh --all`');
    }
    return success('world', 'find', {
      query,
      strategy: 'keyword',
      degraded: true,
      count: keywordResults.length,
      results: keywordResults.map(r => toWorldSearchResult(r)),
      notice: { message: 'Semantic search unavailable, degraded to keyword', hint: message },
    });
  }

  if (!semanticReady) {
    if (strategy === 'semantic') {
      return failure('world', 'find', 'provider_error',
        'Semantic index not ready',
        'Run `pin world index refresh --all --json` to build the semantic index');
    }
    return success('world', 'find', {
      query,
      strategy: 'keyword',
      degraded: true,
      count: keywordResults.length,
      results: keywordResults.map(r => toWorldSearchResult(r)),
      notice: { message: 'Semantic index not ready, degraded to keyword', hint: 'Run `pin world index refresh --all --json`' },
    });
  }

  // Semantic search
  let semanticItems: Array<{ row: db.WorldSignalRow; score: number }> = [];
  try {
    const queryVector = (await embeddingProvider.embedTexts([query]))[0] ?? [];
    const semanticHits = await semanticIndex.search(queryVector, {
      limit: Math.max(limit * 3, 20),
    });
    const rows = await db.listWorldSignalsByIds(semanticHits.map(h => h.id));
    semanticItems = rows
      .filter(row => {
        if (flags['since'] && (row.published_at ?? row.created_at) < flags['since']) return false;
        return true;
      })
      .map(row => ({
        row,
        score: semanticHits.find(h => h.id === row.id)?.score ?? 0,
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'semantic provider unavailable';
    if (strategy === 'semantic') {
      return failure('world', 'find', 'provider_error',
        `Semantic search failed: ${message}`,
        'Check OPENAI_API_KEY and embedding service status');
    }
    return success('world', 'find', {
      query,
      strategy: 'keyword',
      degraded: true,
      count: keywordResults.length,
      results: keywordResults.map(r => toWorldSearchResult(r)),
      notice: { message: 'Semantic search failed, degraded to keyword', hint: message },
    });
  }

  if (strategy === 'semantic') {
    const results = semanticItems.slice(0, limit).map(({ row, score }) =>
      toWorldSearchResult(row, score, 'semantic'),
    );
    return success('world', 'find', {
      query,
      strategy: 'semantic',
      degraded: false,
      count: results.length,
      results,
    });
  }

  // Hybrid: RRF fusion
  const fused = reciprocalRankFusion(keywordResults, semanticItems).slice(0, limit);
  const semanticMap = new Map(semanticItems.map(s => [s.row.id, s]));
  const keywordMap = new Map(keywordResults.map(r => [r.id, r]));

  const results = fused
    .map(item => {
      const semantic = semanticMap.get(item.id);
      if (semantic) {
        return toWorldSearchResult(semantic.row, item.score, item.reason === 'keyword' ? 'semantic' : item.reason);
      }
      const keyword = keywordMap.get(item.id);
      return keyword ? toWorldSearchResult(keyword, item.score, item.reason) : null;
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return success('world', 'find', {
    query,
    strategy: 'hybrid',
    degraded: false,
    count: results.length,
    results,
  });
}

// ── Profile-scored shortlist ──

async function handleShortlist(flags: Record<string, string>): Promise<string> {
  const limit = flags['limit'] ? parseInt(flags['limit'], 10) : 10;
  const interests = await db.listInterests({ limit: 100 });

  // Fetch more items than needed so scoring can filter/rank
  const items = await db.listWorldSignals({ limit: Math.max(limit * 5, 20) });

  if (items.length === 0) {
    return success('world', 'shortlist', { count: 0, items: [], notice: 'No world items found' });
  }

  if (interests.length === 0) {
    // No interests: just return recent items
    const sliced = items.slice(0, limit);
    return success('world', 'shortlist', {
      count: sliced.length,
      items: sliced,
      notice: 'No interests found, returning recent items',
    });
  }

  const shortlisted = items
    .map(item => {
      const scored = scoreWorldSignalForProfile(item, interests);
      return {
        id: item.id,
        title: item.title,
        summary: item.summary,
        topics: item.topics ?? [],
        importance: item.importance ?? null,
        publishedAt: item.published_at,
        profileScore: scored.profileScore,
        reasons: scored.reasons,
      };
    })
    .sort((a, b) => {
      const scoreDiff = b.profileScore - a.profileScore;
      if (scoreDiff !== 0) return scoreDiff;
      return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
    })
    .slice(0, limit);

  return success('world', 'shortlist', { count: shortlisted.length, items: shortlisted });
}
