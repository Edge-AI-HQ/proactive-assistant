/**
 * `pin skills ...` — v3 skill_index + skills/<id>/SKILL.md folder CLI.
 * See docs/memory-architecture.md §六.
 */
import { readFileSync } from 'node:fs';
import { parseArgs, success, failure } from './shared.js';
import * as db from '../db.js';

export async function handleSkills(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (!sub || sub === 'help') {
    return success('skills', 'help', {
      commands: ['list', 'show', 'add', 'update', 'enable', 'disable'],
      examples: [
        'pin skills list --status enabled',
        'pin skills show --id <skill_id>',
        'pin skills add --id <id> --title "Coffee" --from-file SKILL.md --source manual',
        'pin skills update --id <id> --from-file SKILL.md',
        'pin skills enable --id <id>',
        'pin skills disable --id <id>',
      ],
    });
  }

  if (sub === 'list') {
    const limit = flags['limit'] ? Number(flags['limit']) : 100;
    const rows = await db.listSkills({
      status: (flags['status'] as db.SkillStatus | undefined),
      source: flags['source'],
      limit,
    });
    return success('skills', 'list', { count: rows.length, skills: rows });
  }

  if (sub === 'show') {
    const id = flags['id'];
    if (!id) return failure('skills', 'show', 'validation', 'Missing --id');
    const row = await db.getSkillIndex(id);
    if (!row) return failure('skills', 'show', 'not_found', `Skill ${id} not found`);
    const body = db.readSkillBody(id);
    return success('skills', 'show', { skill: row, body });
  }

  if (sub === 'add') {
    const id = flags['id'];
    const title = flags['title'];
    const source = flags['source'];
    if (!id || !title || !source) {
      return failure('skills', 'add', 'validation', 'Missing --id, --title, or --source');
    }
    let body: string;
    if (flags['from-file']) {
      try { body = readFileSync(flags['from-file'], 'utf8'); }
      catch (err) { return failure('skills', 'add', 'io', `Cannot read --from-file: ${err}`); }
    } else if (flags['body']) {
      body = flags['body'];
    } else {
      return failure('skills', 'add', 'validation', 'Provide --body or --from-file');
    }
    const triggers = flags['triggers']
      ? flags['triggers'].split(',').map((t) => t.trim()).filter(Boolean) : [];
    const row = await db.addSkill({
      id, title, body,
      description: flags['description'] ?? null,
      triggers, source,
      createdRunId: flags['createdRunId'] ?? flags['created-run-id'] ?? null,
      status: (flags['status'] as db.SkillStatus | undefined),
    });
    return success('skills', 'add', { skill: row });
  }

  if (sub === 'update') {
    const id = flags['id'];
    if (!id) return failure('skills', 'update', 'validation', 'Missing --id');
    let body: string | undefined;
    if (flags['from-file']) {
      try { body = readFileSync(flags['from-file'], 'utf8'); }
      catch (err) { return failure('skills', 'update', 'io', `Cannot read --from-file: ${err}`); }
    } else if (flags['body']) {
      body = flags['body'];
    }
    const triggers = flags['triggers']
      ? flags['triggers'].split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const row = await db.updateSkill({
      id,
      title: flags['title'],
      description: flags['description'],
      body,
      triggers,
      lastUpdatedRunId: flags['lastUpdatedRunId'] ?? flags['last-updated-run-id'],
    });
    return success('skills', 'update', { skill: row });
  }

  if (sub === 'enable') {
    if (!flags['id']) return failure('skills', 'enable', 'validation', 'Missing --id');
    const row = await db.enableSkill(flags['id']);
    return success('skills', 'enable', { skill: row });
  }

  if (sub === 'disable') {
    if (!flags['id']) return failure('skills', 'disable', 'validation', 'Missing --id');
    const row = await db.disableSkill(flags['id']);
    return success('skills', 'disable', { skill: row });
  }

  return failure('skills', sub, 'validation', `Unknown skills command: ${sub}`,
    'Available: list, show, add, update, enable, disable');
}
