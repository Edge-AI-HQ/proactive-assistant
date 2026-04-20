import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleSkills } from './skills.ts';
import { addUserSkill, resetDbForTests } from '../db.ts';

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

test('GET /skills returns empty list when none exist', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, skills: [] });
}));

test('GET /skills?status=active filters disabled skills', withTempHome(async () => {
  await addUserSkill({ title: 'Active one', body_md: 'body a', source: 'crystallize', status: 'active' });
  await addUserSkill({ title: 'Disabled one', body_md: 'body b', source: 'crystallize', status: 'disabled' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills?status=active');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as { ok: boolean; skills: Array<{ title: string; status: string }> };
  assert.equal(parsed.skills.length, 1);
  assert.equal(parsed.skills[0]!.title, 'Active one');
}));

test('GET /skills/:id returns 404 for unknown id', withTempHome(async () => {
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', '/skills/does-not-exist');
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
}));

test('GET /skills/:id returns the skill', withTempHome(async () => {
  const created = await addUserSkill({ title: 'T', body_md: 'B', source: 'manual' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('GET', `/skills/${created.id}`);
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body) as { ok: boolean; skill: { id: string; title: string } };
  assert.equal(parsed.skill.id, created.id);
  assert.equal(parsed.skill.title, 'T');
}));

test('PATCH /skills/:id updates title, triggers, and status', withTempHome(async () => {
  const created = await addUserSkill({ title: 'Old', body_md: 'Body', source: 'crystallize' });
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

test('PATCH /skills/:id rejects invalid status', withTempHome(async () => {
  const created = await addUserSkill({ title: 't', body_md: 'b', source: 'manual' });
  const handler = handleSkills();
  const { ctx, res } = makeCtx('PATCH', `/skills/${created.id}`, { status: 'banana' });
  const handled = await handler(ctx);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
  assert.match(parsed.error, /status must be/);
}));

test('PATCH /skills/:id rejects empty title', withTempHome(async () => {
  const created = await addUserSkill({ title: 't', body_md: 'b', source: 'manual' });
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

test('DELETE /skills/:id removes the skill', withTempHome(async () => {
  const created = await addUserSkill({ title: 't', body_md: 'b', source: 'manual' });
  const handler = handleSkills();

  const del = makeCtx('DELETE', `/skills/${created.id}`);
  const handled = await handler(del.ctx);
  assert.equal(handled, true);
  assert.equal(del.res.statusCode, 200);

  const get = makeCtx('GET', `/skills/${created.id}`);
  await handler(get.ctx);
  assert.equal(get.res.statusCode, 404);
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
