/**
 * `pin evolution ...` — v3 evolution_runs CLI.
 * See docs/memory-architecture.md §六.
 */
import { parseArgs, success, failure, readLimitFlag, readNumericFlag } from './shared.js';
import * as db from '../db.js';

export async function handleEvolution(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('evolution', 'help', {
      commands: ['list', 'get', 'recent', 'create', 'delta', 'refs', 'complete', 'fail'],
      examples: [
        'pin evolution recent --kind daily_dream --limit 5',
        'pin evolution list --status completed --limit 20',
        'pin evolution get --id <run_id>',
        'pin evolution create --triggerKind manual --contextSummary "..."',
        'pin evolution delta --id <run_id> --memoriesWritten 3 --skillsAdded 1',
        'pin evolution refs consumed --id <run_id> --table memory --ids m1,m2',
        'pin evolution refs produced --id <run_id> --table memory --ids m3',
        'pin evolution complete --id <run_id> --llmTokens 1234 --durationMs 5000',
        'pin evolution fail --id <run_id> --error "LLM timeout"',
      ],
    });
  }

  if (sub === 'recent' || sub === 'list') {
    const limitRes = readLimitFlag(flags, 'evolution', sub);
    if ('failure' in limitRes) return limitRes.failure;
    const limit = limitRes.value ?? (sub === 'recent' ? 10 : 50);
    const triggerKind = (flags['kind'] ?? flags['triggerKind']) as db.EvolutionTrigger | undefined;
    const status = flags['status'] as db.EvolutionRunStatus | undefined;
    const rows = await db.listEvolutionRuns({ triggerKind, status, since: flags['since'], limit });
    return success('evolution', sub, { count: rows.length, runs: rows });
  }

  if (sub === 'get') {
    if (!flags['id']) return failure('evolution', 'get', 'validation', 'Missing --id');
    const row = await db.getEvolutionRun(flags['id']);
    if (!row) return failure('evolution', 'get', 'not_found', `Run ${flags['id']} not found`);
    return success('evolution', 'get', { run: row });
  }

  if (sub === 'create') {
    const triggerKind = (flags['triggerKind'] ?? flags['kind']) as db.EvolutionTrigger | undefined;
    if (!triggerKind) {
      return failure('evolution', 'create', 'validation', 'Missing --triggerKind',
        'one of: chat_burst, daily_dream, manual, on_event, consolidation');
    }
    const row = await db.createEvolutionRun({
      triggerKind,
      windowStart: flags['windowStart'] ?? flags['window-start'] ?? null,
      windowEnd: flags['windowEnd'] ?? flags['window-end'] ?? null,
      contextSummary: flags['contextSummary'] ?? flags['context-summary'] ?? null,
      promptExcerpt: flags['promptExcerpt'] ?? flags['prompt-excerpt'] ?? null,
    });
    return success('evolution', 'create', { run: row });
  }

  if (sub === 'delta') {
    if (!flags['id']) return failure('evolution', 'delta', 'validation', 'Missing --id');
    const num = (k: string) => readNumericFlag(flags, [k], 'evolution', 'delta');
    const memoriesWritten = num('memoriesWritten');
    if ('failure' in memoriesWritten) return memoriesWritten.failure;
    const memoriesArchived = num('memoriesArchived');
    if ('failure' in memoriesArchived) return memoriesArchived.failure;
    const memoriesSuperseded = num('memoriesSuperseded');
    if ('failure' in memoriesSuperseded) return memoriesSuperseded.failure;
    const skillsAdded = num('skillsAdded');
    if ('failure' in skillsAdded) return skillsAdded.failure;
    const skillsUpdated = num('skillsUpdated');
    if ('failure' in skillsUpdated) return skillsUpdated.failure;
    const skillsDisabled = num('skillsDisabled');
    if ('failure' in skillsDisabled) return skillsDisabled.failure;
    const signalsConsumed = num('signalsConsumed');
    if ('failure' in signalsConsumed) return signalsConsumed.failure;
    await db.recordEvolutionDelta(flags['id'], {
      memoriesWritten: memoriesWritten.value,
      memoriesArchived: memoriesArchived.value,
      memoriesSuperseded: memoriesSuperseded.value,
      profileUpdated: flags['profileUpdated'] === 'true' ? true : (flags['profileUpdated'] === 'false' ? false : undefined),
      profileChangedKeys: flags['profileChangedKeys']
        ? flags['profileChangedKeys'].split(',').map((k) => k.trim()).filter(Boolean) : undefined,
      skillsAdded: skillsAdded.value,
      skillsUpdated: skillsUpdated.value,
      skillsDisabled: skillsDisabled.value,
      signalsConsumed: signalsConsumed.value,
    });
    return success('evolution', 'delta', { id: flags['id'] });
  }

  if (sub === 'refs') {
    const direction = positional[1];
    const id = flags['id'];
    const table = flags['table'];
    const ids = flags['ids'] ? flags['ids'].split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!id) return failure('evolution', `refs.${direction ?? '?'}`, 'validation', 'Missing --id');
    if (!table) return failure('evolution', `refs.${direction ?? '?'}`, 'validation', 'Missing --table');
    if (direction === 'consumed') {
      await db.recordEvolutionRefsConsumed(id, table, ids);
      return success('evolution', 'refs.consumed', { id, table, count: ids.length });
    }
    if (direction === 'produced') {
      await db.recordEvolutionRefsProduced(id, table, ids);
      return success('evolution', 'refs.produced', { id, table, count: ids.length });
    }
    return failure('evolution', 'refs', 'validation', `Unknown refs direction: ${direction}`,
      'Available: consumed, produced');
  }

  if (sub === 'complete') {
    if (!flags['id']) return failure('evolution', 'complete', 'validation', 'Missing --id');
    const llmTokens = readNumericFlag(flags, ['llmTokens'], 'evolution', 'complete');
    if ('failure' in llmTokens) return llmTokens.failure;
    const durationMs = readNumericFlag(flags, ['durationMs'], 'evolution', 'complete');
    if ('failure' in durationMs) return durationMs.failure;
    const row = await db.completeEvolutionRun(flags['id'], {
      llmTokens: llmTokens.value,
      durationMs: durationMs.value,
    });
    return success('evolution', 'complete', { run: row });
  }

  if (sub === 'fail') {
    if (!flags['id']) return failure('evolution', 'fail', 'validation', 'Missing --id');
    const row = await db.failEvolutionRun(flags['id'], flags['error'] ?? 'unknown');
    return success('evolution', 'fail', { run: row });
  }

  return failure('evolution', sub, 'validation', `Unknown evolution command: ${sub}`,
    'Available: list, get, recent, create, delta, refs, complete, fail');
}
