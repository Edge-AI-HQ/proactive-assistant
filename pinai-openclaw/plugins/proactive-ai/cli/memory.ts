/**
 * `pin memory ...` — v3 sedimented memory CLI.
 * See docs/memory-architecture.md §六 (CLI / agent interface).
 */
import { parseArgs, success, failure } from './shared.js';
import * as db from '../db.js';

export async function handleMemory(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('memory', 'help', {
      commands: ['list', 'get', 'add', 'archive', 'supersede', 'search'],
      examples: [
        'pin memory list --minQuality 0.7 --limit 30',
        'pin memory list --subjectPrefix person: --limit 20',
        'pin memory get --id <memory_id>',
        'pin memory add --text "..." --source manual --quality 0.7 --subject self',
        'pin memory archive --id <memory_id>',
        'pin memory supersede --old <id> --new <id>',
        'pin memory search --query "投资 偏好" --limit 10',
      ],
    });
  }

  if (sub === 'list') {
    const limit = flags['limit'] ? Number(flags['limit']) : undefined;
    const minQuality = flags['minQuality'] ? Number(flags['minQuality']) : (flags['quality'] ? Number(flags['quality']) : undefined);
    const memories = await db.listMemoryV3({
      status: (flags['status'] as db.MemoryStatus | undefined) ?? 'active',
      minQuality,
      source: flags['source'],
      subject: flags['subject'],
      subjectPrefix: flags['subjectPrefix'] ?? flags['subject-prefix'],
      since: flags['since'],
      until: flags['until'],
      orderBy: flags['orderBy'] as 'created_at' | 'quality' | 'last_referenced_at' | undefined,
      orderDirection: flags['orderDirection'] as 'asc' | 'desc' | undefined,
      limit,
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
    const text = flags['text'];
    const source = flags['source'];
    if (!text) return failure('memory', 'add', 'validation', 'Missing --text');
    if (!source) return failure('memory', 'add', 'validation', 'Missing --source', 'e.g. manual / crystallize / extract:gmail');
    const tags = flags['tags'] ? flags['tags'].split(',').map((t) => t.trim()).filter(Boolean) : [];
    const row = await db.addMemoryV3({
      text,
      source,
      subject: flags['subject'] ?? null,
      quality: flags['quality'] ? Number(flags['quality']) : undefined,
      confidence: flags['confidence'] ? Number(flags['confidence']) : undefined,
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
    // v1 uses substring on text; v3 vector index is a future PR
    const limit = flags['limit'] ? Number(flags['limit']) : 20;
    const all = await db.listMemoryV3({
      status: 'active',
      limit: 500,
      orderBy: 'quality',
    });
    const lowered = query.toLowerCase();
    const matched = all
      .filter((m) => m.text.toLowerCase().includes(lowered) ||
                     (m.subject ?? '').toLowerCase().includes(lowered) ||
                     m.tags.some((t) => t.toLowerCase().includes(lowered)))
      .slice(0, limit);
    return success('memory', 'search', { query, count: matched.length, memories: matched });
  }

  return failure('memory', sub, 'validation', `Unknown memory command: ${sub}`,
    'Available: list, get, add, archive, supersede, search');
}
