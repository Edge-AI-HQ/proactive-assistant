/**
 * `pin memory ...` — v3 sedimented memory CLI.
 * See docs/memory-architecture.md §六 (CLI / agent interface).
 */
import {
  parseArgs, success, failure,
  parseFiniteNumber, readNumericFlag, readLimitFlag,
} from './shared.js';
import * as db from '../db.js';

export async function handleMemory(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('memory', 'help', {
      commands: ['list', 'get', 'add', 'archive', 'supersede', 'search'],
      examples: [
        'pin memory list --quality 0.7 --limit 30',
        'pin memory list --subjectPrefix person: --limit 20',
        'pin memory get --id <memory_id>',
        'pin memory add "<text>" --quality 0.6 --subject self',
        'pin memory add --text "<text>" --source manual --quality 0.7',
        'pin memory archive --id <memory_id>',
        'pin memory supersede --old <id> --new <id>',
        'pin memory search --query "投资 偏好" --limit 10',
      ],
      flagAliases: {
        limit: ['limit', 'top', 'max'],
        minQuality: ['minQuality', 'quality'],
      },
    });
  }

  if (sub === 'list') {
    const limitRes = readLimitFlag(flags, 'memory', 'list');
    if ('failure' in limitRes) return limitRes.failure;
    const qRes = readNumericFlag(flags, ['minQuality', 'quality'], 'memory', 'list');
    if ('failure' in qRes) return qRes.failure;
    const memories = await db.listMemoryV3({
      status: (flags['status'] as db.MemoryStatus | undefined) ?? 'active',
      minQuality: qRes.value,
      source: flags['source'],
      subject: flags['subject'],
      subjectPrefix: flags['subjectPrefix'] ?? flags['subject-prefix'],
      since: flags['since'],
      until: flags['until'],
      orderBy: flags['orderBy'] as 'created_at' | 'quality' | 'last_referenced_at' | undefined,
      orderDirection: flags['orderDirection'] as 'asc' | 'desc' | undefined,
      limit: limitRes.value,
    });
    return success('memory', 'list', { count: memories.length, memories });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('memory', 'get', 'validation', 'Missing --id');
    const row = await db.getMemoryV3(flags['id']);
    if (!row) return failure('memory', 'get', 'not_found', `Memory ${flags['id']} not found`);
    return success('memory', 'get', { memory: row });
  }

  if (sub === 'add') {
    // Accept either `--text "..."` or a positional arg `pin memory add "<text>"`
    const text = flags['text'] ?? positional[1];
    const source = flags['source'] ?? 'manual';        // default makes one-shot calls easier
    if (!text) {
      return failure('memory', 'add', 'validation',
        'Missing text — pass --text "..." or as a positional arg');
    }
    // Validate numeric flags loudly — silently dropping them was a bug:
    // the caller assumed the value took effect and never noticed.
    const qualityRes = readNumericFlag(flags, ['quality'], 'memory', 'add');
    if ('failure' in qualityRes) return qualityRes.failure;
    const confidenceRes = readNumericFlag(flags, ['confidence'], 'memory', 'add');
    if ('failure' in confidenceRes) return confidenceRes.failure;
    const tags = flags['tags'] ? flags['tags'].split(',').map((t) => t.trim()).filter(Boolean) : [];
    const row = await db.addMemoryV3({
      text,
      source,
      subject: flags['subject'] ?? null,
      quality: qualityRes.value,
      confidence: confidenceRes.value,
      occurredAt: flags['occurredAt'] ?? flags['occurred-at'] ?? null,
      tags,
      sourceRunId: flags['sourceRunId'] ?? flags['source-run-id'] ?? null,
    });
    return success('memory', 'add', { memory: row });
  }

  if (sub === 'archive') {
    if (!flags['id']) return failure('memory', 'archive', 'validation', 'Missing --id');
    await db.archiveMemoryV3(flags['id']);
    return success('memory', 'archive', { id: flags['id'] });
  }

  if (sub === 'supersede') {
    const oldId = flags['old'] ?? flags['oldId'];
    const newId = flags['new'] ?? flags['newId'];
    if (!oldId || !newId) {
      return failure('memory', 'supersede', 'validation', 'Missing --old or --new');
    }
    await db.supersedeMemoryV3(oldId, newId);
    return success('memory', 'supersede', { oldId, newId });
  }

  if (sub === 'search') {
    const query = flags['query'] ?? flags['q'];
    if (!query) return failure('memory', 'search', 'validation', 'Missing --query');
    const limitRes = readLimitFlag(flags, 'memory', 'search');
    if ('failure' in limitRes) return limitRes.failure;
    // v1 substring search: pushed into SQL (LIKE on text/subject/tags_json)
    // so LIMIT applies to the filtered set. A vector-backed variant is a
    // future PR; for now this keeps "search" honest on >500-row stores.
    const matched = await db.listMemoryV3({
      status: 'active',
      since: flags['since'],
      until: flags['until'],
      textQuery: query,
      limit: limitRes.value ?? 20,
      orderBy: 'quality',
    });
    return success('memory', 'search', { query, count: matched.length, memories: matched });
  }

  return failure('memory', sub, 'validation', `Unknown memory command: ${sub}`,
    'Available: list, get, add, archive, supersede, search');
}

// Re-export for backward-compat with any external importer that used the
// local helpers before they moved to shared.ts.
export { parseFiniteNumber };
