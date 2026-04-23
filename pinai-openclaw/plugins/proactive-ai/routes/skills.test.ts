import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleSkills } from './skills.ts';
import { addSkill, resetDbForTests } from '../db.ts';

function withTempHome(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.OPENCLAW_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-routes-'));
    process.env.OPENCLAW_HOME = home;
    resetDbForTests();
    try {
      await fn();
    } finally {
      resetDbForTests();
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function createRequest(method: string, body?: Record<string, unknown>) {
  const req = new PassThrough() as PassThrough & { method: string };
  req.method = method;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      response.statusCode = status;
      response.headers = headers;
      return response;
    },
    end(chunk?: string) {
      if (chunk) response.body += chunk;
      return response;
    },
  };
  return response;
}

function makeCtx(method: string, subpath: string, body?: Record<string, unknown>) {
  const res = createResponse();
  const req = createRequest(method, body);
  const url = new URL(`http://localhost${subpath}`);
  const ctx = {
    subpath: url.pathname,
    req,
    res,
    url,
    api: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } },
  } as never;
  return { ctx, res };
}

async function seedSkill(input: { id: string; title: string; body?: string; status?: 'enabled' | 'disabled' | 'archived' }) {
  return addSkill({
    id: input.id,
    title: input.title,
    body: input.body ?? 'seed body',
    source: 'crystallize',
    status: input.status ?? 'enabled',
  });
}

test('GET /skills returns empty list when none exist', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, skills: [] });
}));

test('GET /skills?status=enabled filters disabled skills', withTempHome(async () => {
  await seedSkill({ id: 's-active', title: 'Active one' });
  await seedSkill({ id: 's-disabled', title: 'Disabled one', status: 'disabled' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills?status=enabled');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as { ok: boolean; skills: Array<{ title: string; status: string }> };
  assert.equal(parsed.skills.length, 1);
  assert.equal(parsed.skills[0]!.title, 'Active one');
  assert.equal(parsed.skills[0]!.status, 'enabled');
}));

test('GET /skills/:id returns 404 for unknown id', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills/does-not-exist');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
}));

test('GET /skills/:id returns the skill with body', withTempHome(async () => {
  const created = await seedSkill({ id: 's-show', title: 'T', body: 'Body content' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', `/skills/${created.id}`);
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as {
    ok: boolean;
    skill: { id: string; title: string; status: string; body: string; revision: number };
  };
  assert.equal(parsed.skill.id, created.id);
  assert.equal(parsed.skill.title, 'T');
  assert.equal(parsed.skill.status, 'enabled');
  assert.equal(parsed.skill.body, 'Body content');
  assert.equal(parsed.skill.revision, 1);
}));

test('POST /skills creates a manual skill with defaults', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('POST', '/skills', {
    title: 'Manual skill',
    body: 'Use this when the user asks about X.',
    description: 'test',
    triggers: ['asks about x'],
  });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as {
    ok: boolean;
    skill: { id: string; title: string; source: string; status: string; body: string; description: string | null };
  };
  assert.ok(parsed.skill.id);
  assert.equal(parsed.skill.title, 'Manual skill');
  assert.equal(parsed.skill.source, 'manual');
  assert.equal(parsed.skill.status, 'enabled');
  assert.equal(parsed.skill.body, 'Use this when the user asks about X.');
  assert.equal(parsed.skill.description, 'test');
}));

test('POST /skills rejects empty title', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('POST', '/skills', { title: '   ', body: 'x' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.match(parsed.error, /title/);
}));

test('POST /skills rejects empty body', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('POST', '/skills', { title: 'ok', body: '  ' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.match(parsed.error, /body/);
}));

test('PATCH /skills/:id updates title, triggers, and status → disabled', withTempHome(async () => {
  const created = await seedSkill({ id: 's-patch', title: 'Old' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', `/skills/${created.id}`, {
    title: 'New Title',
    triggers: ['asks about pricing'],
    status: 'disabled',
  });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as {
    ok: boolean;
    skill: { title: string; status: string; triggers: string[] };
  };
  assert.equal(parsed.skill.title, 'New Title');
  assert.equal(parsed.skill.status, 'disabled');
  assert.deepEqual(parsed.skill.triggers, ['asks about pricing']);
}));

test('PATCH /skills/:id bumps revision when body changes', withTempHome(async () => {
  const created = await seedSkill({ id: 's-rev', title: 't', body: 'original body' });
  assert.equal(created.revision, 1);
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', `/skills/${created.id}`, { body: 'brand new body' });
  await handler(ctx);
  const parsed = JSON.parse(res.body) as { skill: { revision: number; body: string } };
  assert.equal(parsed.skill.revision, 2);
  assert.equal(parsed.skill.body, 'brand new body');
}));

test('PATCH /skills/:id rejects invalid status', withTempHome(async () => {
  const created = await seedSkill({ id: 's-bad-status', title: 't' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', `/skills/${created.id}`, { status: 'banana' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.match(parsed.error, /status must be/);
}));

test('PATCH /skills/:id rejects empty title', withTempHome(async () => {
  const created = await seedSkill({ id: 's-empty-title', title: 't' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', `/skills/${created.id}`, { title: '   ' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
}));

test('PATCH /skills/:id returns 404 for unknown id', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', '/skills/nope', { title: 'x' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
}));

test('DELETE /skills/:id archives the skill (soft-delete)', withTempHome(async () => {
  const created = await seedSkill({ id: 's-del', title: 't' });
  const handler = handleSkills();

  const del = makeCtx('DELETE', `/skills/${created.id}`);
  const handled = await handler(del.ctx);
  assert.equal(handled, true);
  assert.equal(del.res.statusCode, 200);
  const delParsed = JSON.parse(del.res.body) as { ok: boolean; skill: { status: string } };
  assert.equal(delParsed.skill.status, 'archived');

  // GET on the default (enabled) list no longer shows it
  const list = makeCtx('GET', '/skills?status=enabled');
  await handler(list.ctx);
  const listParsed = JSON.parse(list.res.body) as { skills: Array<{ id: string }> };
  assert.equal(listParsed.skills.length, 0);

  // but direct GET still returns it with status='archived'
  const get = makeCtx('GET', `/skills/${created.id}`);
  await handler(get.ctx);
  assert.equal(get.res.statusCode, 200);
  const getParsed = JSON.parse(get.res.body) as { skill: { status: string } };
  assert.equal(getParsed.skill.status, 'archived');
}));

test('DELETE /skills/:id returns 404 for unknown id', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('DELETE', '/skills/missing');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
}));

test('handler returns false for unrelated subpaths', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx } = makeCtx('GET', '/dreaming/runs');
  const handled = await handler(ctx);
  assert.equal(handled, false);
}));
