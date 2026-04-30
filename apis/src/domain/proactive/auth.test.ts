/**
 * Verifies every behavioural change in the recent auth refactor:
 *   - P1 unified error response shape `{ error, code }`
 *   - P3 token verification cache (hit avoids re-verify; TTL + FIFO eviction)
 *   - DI-friendly factory (createRequireProactiveAuth) so production/test
 *     paths share one implementation
 *   - log-context attribution after a successful auth
 *   - upsertUser failure surfaces as 401 instead of an unhandled rejection
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import type { Request, Response } from 'express';

import {
  createRequireProactiveAuth,
  createTokenCache,
  isExpiredAuthError,
  TokenVerifyError,
  type ProactiveAuthDeps,
} from './auth.js';
import type { ProactiveUser } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const makeSupabaseUser = (overrides: Partial<SupabaseUser> = {}): SupabaseUser => ({
  id: 'aaaa-bbbb-cccc-dddd',
  app_metadata: {},
  user_metadata: { full_name: 'Test User' },
  aud: 'authenticated',
  created_at: '2026-01-01T00:00:00Z',
  email: 'test@example.com',
  ...overrides,
} as SupabaseUser);

const makeUserRow = (overrides: Partial<ProactiveUser> = {}): ProactiveUser => ({
  id: 1,
  supabase_user_id: 'aaaa-bbbb-cccc-dddd',
  email: 'test@example.com',
  display_name: 'Test User',
  avatar_url: null,
  auth_provider: 'google',
  container_proxy_secret: 'secret-xxxxx',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_active_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeResponse;
  json(value: unknown): FakeResponse;
}

const makeRes = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  return res;
};

const makeReq = (authHeader?: string): Request => ({
  headers: authHeader ? { authorization: authHeader } : {},
} as unknown as Request);

interface SpyDeps {
  verifyTokenCalls: string[];
  upsertUserCalls: Array<Parameters<ProactiveAuthDeps['upsertUser']>[0]>;
  logContextCalls: Array<{ userId: number | string | null | undefined; username: string | null | undefined }>;
}

const buildDeps = (
  overrides: Partial<ProactiveAuthDeps> = {},
): { deps: ProactiveAuthDeps; spy: SpyDeps } => {
  const spy: SpyDeps = {
    verifyTokenCalls: [],
    upsertUserCalls: [],
    logContextCalls: [],
  };
  const deps: ProactiveAuthDeps = {
    verifyToken: async (token) => {
      spy.verifyTokenCalls.push(token);
      return makeSupabaseUser();
    },
    cache: createTokenCache(),
    upsertUser: async (params) => {
      spy.upsertUserCalls.push(params);
      return makeUserRow();
    },
    setLogContextIdentity: (userId, username) => {
      spy.logContextCalls.push({ userId, username });
    },
    ...overrides,
  };
  return { deps, spy };
};

// ---------------------------------------------------------------------------
// P1 — error response shape
// ---------------------------------------------------------------------------

test('TOKEN_MISSING when Authorization header is absent', async () => {
  const { deps, spy } = buildDeps();
  const middleware = createRequireProactiveAuth(deps);
  const req = makeReq();
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res as unknown as Response, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Missing authorization token', code: 'TOKEN_MISSING' });
  assert.equal(nextCalled, false);
  assert.equal(spy.verifyTokenCalls.length, 0, 'should not call verify when header missing');
});

test('TOKEN_MISSING when Authorization is not a Bearer token', async () => {
  const { deps } = buildDeps();
  const middleware = createRequireProactiveAuth(deps);
  const req = makeReq('Basic dXNlcjpwYXNz');
  const res = makeRes();
  await middleware(req, res as unknown as Response, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Missing authorization token', code: 'TOKEN_MISSING' });
});

test('dev fallback can synthesize a fixed local user when Authorization is absent', async () => {
  const { deps, spy } = buildDeps({ allowDevFallback: true });
  const middleware = createRequireProactiveAuth(deps);
  const req = makeReq();
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res as unknown as Response, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(spy.verifyTokenCalls.length, 0, 'dev fallback should not verify a missing token');
  assert.deepEqual(spy.upsertUserCalls[0], {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'dev@local.test',
    name: 'dev',
    authProvider: 'dev',
  });
  const reqAny = req as unknown as { proactiveAuth?: { userId: string; user: ProactiveUser } };
  assert.equal(reqAny.proactiveAuth?.userId, '00000000-0000-4000-8000-000000000001');
  assert.equal(reqAny.proactiveAuth?.user.id, 1);
});

test('TOKEN_INVALID surfaces invalid-token verifier failures', async () => {
  const { deps } = buildDeps({
    verifyToken: async () => {
      throw new TokenVerifyError('TOKEN_INVALID', 'bad signature');
    },
  });
  const middleware = createRequireProactiveAuth(deps);
  const res = makeRes();
  await middleware(makeReq('Bearer junk'), res as unknown as Response, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
});

test('TOKEN_EXPIRED surfaces expired-token verifier failures', async () => {
  const { deps } = buildDeps({
    verifyToken: async () => {
      throw new TokenVerifyError('TOKEN_EXPIRED', 'jwt expired');
    },
  });
  const middleware = createRequireProactiveAuth(deps);
  const res = makeRes();
  await middleware(makeReq('Bearer expired-token'), res as unknown as Response, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Invalid or expired token', code: 'TOKEN_EXPIRED' });
});

test('UNAUTHORIZED when verifier throws a non-TokenVerifyError (network/etc.)', async () => {
  const { deps } = buildDeps({
    verifyToken: async () => {
      throw new Error('network down');
    },
  });
  const middleware = createRequireProactiveAuth(deps);
  const res = makeRes();
  await middleware(makeReq('Bearer abc'), res as unknown as Response, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Token verification failed', code: 'UNAUTHORIZED' });
});

test('UNAUTHORIZED when upsertUser throws (DB unavailable)', async () => {
  const { deps } = buildDeps({
    upsertUser: async () => {
      throw new Error('postgres down');
    },
  });
  const middleware = createRequireProactiveAuth(deps);
  const res = makeRes();
  await middleware(makeReq('Bearer abc'), res as unknown as Response, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'User provisioning failed', code: 'UNAUTHORIZED' });
});

// ---------------------------------------------------------------------------
// isExpiredAuthError mapping (drives TOKEN_EXPIRED vs TOKEN_INVALID for the
// real Supabase verifier path)
// ---------------------------------------------------------------------------

test('isExpiredAuthError detects status=401', () => {
  assert.equal(isExpiredAuthError({ status: 401, message: 'unauth' }), true);
});

test('isExpiredAuthError detects "expired" in message', () => {
  assert.equal(isExpiredAuthError({ message: 'jwt expired' }), true);
  assert.equal(isExpiredAuthError({ message: 'Token has expired' }), true);
});

test('isExpiredAuthError returns false for unrelated errors', () => {
  assert.equal(isExpiredAuthError(null), false);
  assert.equal(isExpiredAuthError(undefined), false);
  assert.equal(isExpiredAuthError({ status: 500, message: 'server error' }), false);
  assert.equal(isExpiredAuthError({ message: 'invalid signature' }), false);
});

// ---------------------------------------------------------------------------
// P3 — token verify cache
// ---------------------------------------------------------------------------

test('cache hit avoids a second verifyToken call', async () => {
  const { deps, spy } = buildDeps();
  const middleware = createRequireProactiveAuth(deps);

  await middleware(makeReq('Bearer same-token'), makeRes() as unknown as Response, () => {});
  await middleware(makeReq('Bearer same-token'), makeRes() as unknown as Response, () => {});
  await middleware(makeReq('Bearer same-token'), makeRes() as unknown as Response, () => {});

  assert.equal(spy.verifyTokenCalls.length, 1, 'verify called once across three identical requests');
  assert.equal(spy.upsertUserCalls.length, 3, 'upsertUser still runs every time (it is the throttled write)');
});

test('different tokens are cached independently', async () => {
  const { deps, spy } = buildDeps();
  const middleware = createRequireProactiveAuth(deps);

  await middleware(makeReq('Bearer token-a'), makeRes() as unknown as Response, () => {});
  await middleware(makeReq('Bearer token-b'), makeRes() as unknown as Response, () => {});
  await middleware(makeReq('Bearer token-a'), makeRes() as unknown as Response, () => {});

  assert.equal(spy.verifyTokenCalls.length, 2);
  assert.deepEqual(new Set(spy.verifyTokenCalls), new Set(['token-a', 'token-b']));
});

test('cache returns null past the TTL', async () => {
  const cache = createTokenCache({ ttlMs: 5 });
  cache.set('abc', makeSupabaseUser());
  assert.equal(cache.get('abc')?.id, 'aaaa-bbbb-cccc-dddd');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cache.get('abc'), null, 'expired entry should miss');
});

test('cache enforces FIFO eviction at maxEntries', () => {
  const cache = createTokenCache({ ttlMs: 60_000, maxEntries: 2 });
  cache.set('t1', makeSupabaseUser({ id: 'u1' }));
  cache.set('t2', makeSupabaseUser({ id: 'u2' }));
  assert.equal(cache.size(), 2);

  cache.set('t3', makeSupabaseUser({ id: 'u3' }));
  assert.equal(cache.size(), 2, 'eviction kept us at the cap');
  assert.equal(cache.get('t1'), null, 't1 was the oldest, should have been evicted');
  assert.equal(cache.get('t2')?.id, 'u2');
  assert.equal(cache.get('t3')?.id, 'u3');
});

test('cache.clear empties everything', () => {
  const cache = createTokenCache();
  cache.set('a', makeSupabaseUser());
  cache.set('b', makeSupabaseUser());
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('a'), null);
});

// ---------------------------------------------------------------------------
// Success path: middleware contract with downstream handlers
// ---------------------------------------------------------------------------

test('success path attaches proactiveAuth + calls next + writes log context', async () => {
  const { deps, spy } = buildDeps();
  const middleware = createRequireProactiveAuth(deps);
  const req = makeReq('Bearer good');
  const res = makeRes();
  let nextCalled = false;

  await middleware(req, res as unknown as Response, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null, 'no status set on success');
  const reqAny = req as unknown as { proactiveAuth?: { userId: string; user: ProactiveUser } };
  assert.equal(reqAny.proactiveAuth?.userId, 'aaaa-bbbb-cccc-dddd');
  assert.equal(reqAny.proactiveAuth?.user.id, 1);
  assert.equal(reqAny.proactiveAuth?.user.container_proxy_secret, 'secret-xxxxx');
  assert.equal(spy.logContextCalls.length, 1);
  assert.equal(spy.logContextCalls[0]?.userId, 'aaaa-bbbb-cccc-dddd');
  assert.equal(spy.logContextCalls[0]?.username, 'Test User');
});

test('upsertUser receives the Supabase identity fields', async () => {
  const { deps, spy } = buildDeps({
    verifyToken: async () => makeSupabaseUser({
      id: 'sb-uid',
      email: 'alice@example.com',
      user_metadata: { full_name: 'Alice', avatar_url: 'https://x/a.png' },
    }),
  });
  const middleware = createRequireProactiveAuth(deps);
  await middleware(makeReq('Bearer t'), makeRes() as unknown as Response, () => {});

  assert.equal(spy.upsertUserCalls.length, 1);
  assert.deepEqual(spy.upsertUserCalls[0], {
    userId: 'sb-uid',
    email: 'alice@example.com',
    name: 'Alice',
    avatarUrl: 'https://x/a.png',
  });
});

test('log context falls back to email when display_name is null', async () => {
  const { deps, spy } = buildDeps({
    upsertUser: async () => makeUserRow({ display_name: null, email: 'fallback@example.com' }),
  });
  const middleware = createRequireProactiveAuth(deps);
  await middleware(makeReq('Bearer t'), makeRes() as unknown as Response, () => {});

  assert.equal(spy.logContextCalls[0]?.username, 'fallback@example.com');
});
