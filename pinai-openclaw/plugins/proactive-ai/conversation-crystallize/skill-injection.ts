/**
 * Skill injection — format active user_skills as a prompt section for the
 * Chat and Unified-Generator agents.
 *
 * Size budget (per prompt, not per request cycle):
 *   - Per-skill cap:  2_000 chars (title + triggers + body)
 *   - Global cap:    10_000 chars across all skills in the section
 *   - Skills are ordered by updated_at DESC by caller (db.listUserSkills).
 */

import * as db from '../db.js';
import type { UserSkillRow } from '../db.js';

export const SKILL_SECTION_HEADER = '## Learned User Skills';

export const SKILL_PER_SKILL_CHAR_LIMIT = 2_000;
export const SKILL_GLOBAL_CHAR_LIMIT = 10_000;

export interface FormatUserSkillsOptions {
  perSkillChars?: number;
  globalChars?: number;
}

/**
 * Load active user skills and format them as a single markdown block.
 * Returns an empty string when there are no skills or when the caller
 * wants the section omitted entirely.
 */
export async function loadActiveSkillsSection(
  opts: FormatUserSkillsOptions = {},
): Promise<string> {
  let skills: UserSkillRow[] = [];
  try {
    skills = await db.listUserSkills({ status: 'active', limit: 64 });
  } catch {
    return '';
  }
  return formatUserSkillsSection(skills, opts);
}

export function formatUserSkillsSection(
  skills: UserSkillRow[],
  opts: FormatUserSkillsOptions = {},
): string {
  const perCap = opts.perSkillChars ?? SKILL_PER_SKILL_CHAR_LIMIT;
  const globalCap = opts.globalChars ?? SKILL_GLOBAL_CHAR_LIMIT;

  if (!Array.isArray(skills) || skills.length === 0) return '';

  const rendered: string[] = [];
  let total = 0;
  let truncatedAt = -1;

  for (let i = 0; i < skills.length; i++) {
    const block = renderSkillBlock(skills[i], perCap);
    if (!block) continue;
    if (total + block.length + 2 > globalCap && rendered.length > 0) {
      truncatedAt = i;
      break;
    }
    rendered.push(block);
    total += block.length + 2;
  }

  if (rendered.length === 0) return '';

  const footer = truncatedAt >= 0
    ? `\n\n_Omitted ${skills.length - rendered.length} more skill(s) to stay within the prompt budget._`
    : '';

  const intro =
    'The following skills have been learned from prior conversations. ' +
    'When a skill\'s trigger matches the current context, follow it precisely. ' +
    'If two skills conflict, prefer the most recently updated.';

  return `${SKILL_SECTION_HEADER}\n\n${intro}\n\n${rendered.join('\n\n')}${footer}`;
}

function renderSkillBlock(skill: UserSkillRow, charCap: number): string {
  const title = truncate(skill.title?.trim() || '(untitled skill)', 160);
  const triggers = Array.isArray(skill.triggers)
    ? skill.triggers.filter((t) => typeof t === 'string' && t.trim().length > 0).slice(0, 8)
    : [];
  const body = truncate(skill.body_md?.trim() || '', charCap - 400);

  if (!body) return '';

  const triggerLine = triggers.length > 0
    ? `Triggers: ${triggers.map((t) => `\`${t}\``).join(', ')}`
    : 'Triggers: (none — apply when clearly relevant)';

  const block = `### ${title}\n${triggerLine}\n\n${body}`;
  return truncate(block, charCap);
}

function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
