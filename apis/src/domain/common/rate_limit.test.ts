import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimit } from './rate_limit.js';

test('rate limit: allows up to capacity then 429s', () => {
  const limiter = createRateLimit({
    name: 'test',
    keyFn: () => 'k1',
    capacity: 3,
    refillPerSec: 0,         // no refill — pure burst test
  });
  assert.equal(limiter.take('k1'), true);
  assert.equal(limiter.take('k1'), true);
  assert.equal(limiter.take('k1'), true);
  assert.equal(limiter.take('k1'), false);    // 4th over capacity
});

test('rate limit: distinct keys have independent buckets', () => {
  const limiter = createRateLimit({
    name: 'test',
    keyFn: () => undefined,
    capacity: 2,
    refillPerSec: 0,
  });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  // b is fresh
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.take('b'), false);
});

test('rate limit: refill restores tokens over time', async () => {
  const limiter = createRateLimit({
    name: 'test',
    keyFn: () => 'r1',
    capacity: 2,
    refillPerSec: 100,        // 100 tokens / sec → 1 token / 10ms
  });
  assert.equal(limiter.take('r1'), true);
  assert.equal(limiter.take('r1'), true);
  assert.equal(limiter.take('r1'), false);
  // Wait 30ms — should have ~3 tokens of refill, capped at capacity=2.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(limiter.take('r1'), true);
  assert.equal(limiter.take('r1'), true);
  assert.equal(limiter.take('r1'), false);
});

test('rate limit: 429 responds with structured body via Express middleware', () => {
  const limiter = createRateLimit({
    name: 'ingest',
    keyFn: () => 'fixed',
    capacity: 1,
    refillPerSec: 0,
  });
  // Burn the token.
  limiter.take('fixed');

  const responses: Array<{ status: number; body: unknown }> = [];
  const next = () => responses.push({ status: 200, body: 'next-called' });
  const res = {
    status(s: number) {
      const captured = { status: s, body: undefined as unknown };
      responses.push(captured);
      return {
        json(b: unknown) { captured.body = b; },
      };
    },
  } as unknown as import('express').Response;
  const req = { method: 'POST', path: '/ingest', header: () => undefined } as unknown as import('express').Request;

  limiter(req, res, next);
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.status, 429);
  assert.deepEqual(responses[0]!.body, {
    error: 'Too many requests',
    code: 'RATE_LIMITED',
    limit: 'ingest',
  });
});

test('rate limit: missing key passes through (with warn)', () => {
  const limiter = createRateLimit({
    name: 'permissive',
    keyFn: () => undefined,
    capacity: 1,
    refillPerSec: 0,
  });
  let calls = 0;
  const next = () => { calls += 1; };
  const res = {} as unknown as import('express').Response;
  const req = { method: 'GET', path: '/x', header: () => undefined } as unknown as import('express').Request;
  // Even after capacity would normally be exhausted, missing key skips
  // the bucket lookup entirely.
  limiter(req, res, next);
  limiter(req, res, next);
  limiter(req, res, next);
  assert.equal(calls, 3);
});
