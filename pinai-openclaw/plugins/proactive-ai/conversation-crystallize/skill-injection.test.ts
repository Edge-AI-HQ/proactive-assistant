import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatUserSkillsSection,
  SKILL_SECTION_HEADER,
  SKILL_GLOBAL_CHAR_LIMIT,
  SKILL_PER_SKILL_CHAR_LIMIT,
} from './skill-injection.ts';
import type { UserSkillRow } from '../db.ts';

function makeSkill(partial: Partial<UserSkillRow> & { id: string; title: string; body_md: string }): UserSkillRow {
  return {
    id: partial.id,
    title: partial.title,
    body_md: partial.body_md,
    triggers: partial.triggers ?? [],
    source: partial.source ?? 'crystallize',
    status: partial.status ?? 'active',
    source_summary: partial.source_summary ?? null,
    created_at: partial.created_at ?? '2026-04-20T00:00:00.000Z',
    updated_at: partial.updated_at ?? '2026-04-20T00:00:00.000Z',
  };
}

test('formatUserSkillsSection returns empty string when no skills', () => {
  assert.equal(formatUserSkillsSection([]), '');
});

test('formatUserSkillsSection renders header, intro, title, triggers and body', () => {
  const out = formatUserSkillsSection([
    makeSkill({
      id: 's1',
      title: 'Respond with pricing tables',
      triggers: ['asks about pricing', 'requests a cost breakdown'],
      body_md: 'Use a markdown table with columns Plan | Monthly | Annual.',
    }),
  ]);
  assert.match(out, new RegExp(SKILL_SECTION_HEADER));
  assert.match(out, /Respond with pricing tables/);
  assert.match(out, /Triggers: `asks about pricing`, `requests a cost breakdown`/);
  assert.match(out, /markdown table with columns Plan/);
});

test('formatUserSkillsSection omits skills without a body', () => {
  const out = formatUserSkillsSection([
    makeSkill({ id: 's1', title: 'Empty skill', body_md: '   ' }),
    makeSkill({ id: 's2', title: 'Valid skill', body_md: 'Do the thing.' }),
  ]);
  assert.doesNotMatch(out, /Empty skill/);
  assert.match(out, /Valid skill/);
});

test('formatUserSkillsSection truncates oversize bodies to per-skill cap', () => {
  const body = 'x'.repeat(SKILL_PER_SKILL_CHAR_LIMIT * 2);
  const out = formatUserSkillsSection([
    makeSkill({ id: 's1', title: 'Big skill', body_md: body }),
  ]);
  assert.ok(out.length <= SKILL_PER_SKILL_CHAR_LIMIT + 500, `length was ${out.length}`);
  assert.ok(out.includes('…'), 'should include ellipsis on truncation');
});

test('formatUserSkillsSection enforces global cap and notes omissions', () => {
  const many: UserSkillRow[] = [];
  for (let i = 0; i < 20; i++) {
    many.push(makeSkill({
      id: `s${i}`,
      title: `Skill ${i}`,
      body_md: 'y'.repeat(1500),
    }));
  }
  const out = formatUserSkillsSection(many);
  assert.ok(out.length <= SKILL_GLOBAL_CHAR_LIMIT + 500, `out length ${out.length}`);
  assert.match(out, /Omitted \d+ more skill\(s\)/);
});

test('formatUserSkillsSection falls back when triggers list is empty', () => {
  const out = formatUserSkillsSection([
    makeSkill({ id: 's1', title: 'No triggers', triggers: [], body_md: 'body' }),
  ]);
  assert.match(out, /Triggers: \(none — apply when clearly relevant\)/);
});
