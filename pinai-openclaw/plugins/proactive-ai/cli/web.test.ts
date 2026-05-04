/**
 * Plan B: pin web fetch — SSRF, redirect, content-type, body-cap, timeout.
 *
 * Real network is never touched. We inject a `httpRequest` shim that
 * synthesizes IncomingMessage-shaped responses, and a `resolveHost` shim
 * that returns whatever IP the test wants. This way every safety rule can
 * be exercised deterministically without spinning up a server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  fetchUrl,
  classifyAddressForSsrf,
  htmlToText,
  FetchError,
  handleWeb,
} from './web.ts';

// ── Test helpers ────────────────────────────────────────────────────────

interface FakeResponseDef {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function makeIncomingMessage(def: FakeResponseDef): NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> } {
  const buf = typeof def.body === 'string' ? Buffer.from(def.body, 'utf8') : (def.body ?? Buffer.alloc(0));
  // node:stream Readable.from a single chunk so the .data / .end events
  // fire in order. The test consumer already handles both events.
  const stream = Readable.from([buf]) as NodeJS.ReadableStream & {
    statusCode: number;
    headers: Record<string, string>;
  };
  stream.statusCode = def.status;
  stream.headers = def.headers ?? {};
  return stream;
}

interface ScriptedRequest {
  expectedHost?: string;
  expectedIp?: string;
  response?: FakeResponseDef;
  /** Return null to simulate a hung socket; otherwise the FakeResponseDef. */
  delayMs?: number;
}

function makeHttpRequest(
  scripted: ScriptedRequest[],
  observed?: { hosts: string[]; ips: string[]; paths: string[] },
): any {
  let i = 0;
  return ((opts: any, callback: (res: any) => void) => {
    const def = scripted[i++];
    if (!def) throw new Error(`unexpected extra request to ${opts.hostname}`);
    if (def.expectedHost) assert.equal(opts.hostname, def.expectedHost);
    observed?.hosts.push(String(opts.hostname));
    observed?.paths.push(String(opts.path));

    // Resolve `lookup` as the real https.request would, so we can record
    // which IP node would dial. The handler passes a `lookup` callback; we
    // call it synchronously with whatever def specifies the IP to be.
    if (typeof opts.lookup === 'function') {
      opts.lookup(opts.hostname, {}, (err: Error | null, addr: string) => {
        if (!err) observed?.ips.push(addr);
      });
    }

    const req = new EventEmitter() as any;
    req.end = () => {
      // Async deliver to mimic real http.request behaviour.
      setImmediate(() => {
        if (def.delayMs && def.delayMs > 1_000_000) {
          // pretend hung; the timeout path tests this.
          return;
        }
        if (!def.response) {
          req.emit('error', new Error('no response scripted'));
          return;
        }
        const msg = makeIncomingMessage(def.response);
        callback(msg);
      });
    };
    req.destroy = () => {};
    return req;
  }) as any;
}

// ── classifyAddressForSsrf unit tests ───────────────────────────────────

test('classifyAddressForSsrf: blocks 127.0.0.1', () => {
  const r = classifyAddressForSsrf('127.0.0.1');
  assert.equal(r.blocked, true);
});

test('classifyAddressForSsrf: blocks 169.254.169.254 (AWS metadata)', () => {
  const r = classifyAddressForSsrf('169.254.169.254');
  assert.equal(r.blocked, true);
});

test('classifyAddressForSsrf: blocks 10.0.0.5 / 172.16.1.1 / 192.168.1.1', () => {
  for (const ip of ['10.0.0.5', '172.16.1.1', '192.168.1.1']) {
    const r = classifyAddressForSsrf(ip);
    assert.equal(r.blocked, true, `${ip} should be blocked`);
  }
});

test('classifyAddressForSsrf: blocks IPv6 loopback ::1 and link-local fe80::', () => {
  assert.equal(classifyAddressForSsrf('::1').blocked, true);
  assert.equal(classifyAddressForSsrf('fe80::1').blocked, true);
  assert.equal(classifyAddressForSsrf('fc00::1').blocked, true);
});

test('classifyAddressForSsrf: blocks IPv4-mapped IPv6 (::ffff:127.0.0.1)', () => {
  const r = classifyAddressForSsrf('::ffff:127.0.0.1');
  assert.equal(r.blocked, true);
});

test('classifyAddressForSsrf: allows public IP 8.8.8.8', () => {
  const r = classifyAddressForSsrf('8.8.8.8');
  assert.equal(r.blocked, false);
});

test('classifyAddressForSsrf: allows public IP 142.250.80.46', () => {
  const r = classifyAddressForSsrf('142.250.80.46');
  assert.equal(r.blocked, false);
});

test('classifyAddressForSsrf: blocks multicast 224.0.0.1', () => {
  assert.equal(classifyAddressForSsrf('224.0.0.1').blocked, true);
});

test('classifyAddressForSsrf: blocks 0.0.0.0', () => {
  assert.equal(classifyAddressForSsrf('0.0.0.0').blocked, true);
});

test('classifyAddressForSsrf: blocks CGNAT 100.64.0.5', () => {
  assert.equal(classifyAddressForSsrf('100.64.0.5').blocked, true);
});

test('classifyAddressForSsrf: rejects garbage strings', () => {
  assert.equal(classifyAddressForSsrf('not-an-ip').blocked, true);
});

// ── fetchUrl: scheme blocking ───────────────────────────────────────────

test('fetchUrl: rejects http:// scheme', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'http://example.com',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([]),
    }),
    (err) => err instanceof FetchError && err.code === 'scheme_blocked',
  );
});

test('fetchUrl: rejects file:// scheme', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'file:///etc/passwd',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([]),
    }),
    (err) => err instanceof FetchError && err.code === 'scheme_blocked',
  );
});

// ── fetchUrl: SSRF defense ───────────────────────────────────────────────

test('fetchUrl: rejects URL whose hostname literal is loopback IP', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://127.0.0.1/health',
      // resolveHost would return the same IP, but we should reject before DNS.
      resolveHost: async () => ({ address: '127.0.0.1', family: 4 }),
      httpRequest: makeHttpRequest([]),
    }),
    (err) => err instanceof FetchError && err.code === 'ssrf_blocked',
  );
});

test('fetchUrl: rejects when DNS resolves to private RFC1918 address', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://internal.example.com/secrets',
      resolveHost: async () => ({ address: '10.0.0.5', family: 4 }),
      httpRequest: makeHttpRequest([]),
    }),
    (err) => err instanceof FetchError && err.code === 'ssrf_blocked',
  );
});

test('fetchUrl: rejects when DNS resolves to AWS metadata', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://meta.example.com',
      resolveHost: async () => ({ address: '169.254.169.254', family: 4 }),
      httpRequest: makeHttpRequest([]),
    }),
    (err) => err instanceof FetchError && err.code === 'ssrf_blocked',
  );
});

test('fetchUrl: rejects redirect to internal IP (revalidates per hop)', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://innocent.example.com/article',
      resolveHost: async (host) => {
        if (host === 'innocent.example.com') return { address: '8.8.8.8', family: 4 };
        if (host === 'internal.example.com') return { address: '10.0.0.7', family: 4 };
        throw new Error(`unexpected host ${host}`);
      },
      httpRequest: makeHttpRequest([
        {
          expectedHost: 'innocent.example.com',
          response: { status: 302, headers: { location: 'https://internal.example.com/x' } },
        },
        // The internal hop must NEVER be reached — SSRF blocks it before request.
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'ssrf_blocked',
  );
});

// ── fetchUrl: redirect handling ─────────────────────────────────────────

test('fetchUrl: follows up to MAX_REDIRECTS chain', async () => {
  const result = await fetchUrl({
    url: 'https://a.example.com/start',
    resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
    httpRequest: makeHttpRequest([
      { response: { status: 301, headers: { location: 'https://b.example.com/' } } },
      { response: { status: 301, headers: { location: 'https://c.example.com/' } } },
      { response: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<title>Final</title><p>body</p>' } },
    ]),
  });
  assert.equal(result.status, 200);
  assert.equal(result.title, 'Final');
  assert.equal(result.url, 'https://a.example.com/start');
  assert.equal(result.finalUrl.startsWith('https://c.example.com'), true);
});

test('fetchUrl: rejects more than 3 redirects', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://a.example.com/start',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 301, headers: { location: 'https://b.example.com/' } } },
        { response: { status: 301, headers: { location: 'https://c.example.com/' } } },
        { response: { status: 301, headers: { location: 'https://d.example.com/' } } },
        { response: { status: 301, headers: { location: 'https://e.example.com/' } } },
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'too_many_redirects',
  );
});

test('fetchUrl: rejects redirect with missing Location header', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://a.example.com/',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 302 } },
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'invalid_redirect',
  );
});

// ── fetchUrl: content-type allowlist ─────────────────────────────────────

test('fetchUrl: rejects non-allowed content-type (image/png)', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://a.example.com/x.png',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 200, headers: { 'content-type': 'image/png' }, body: 'binary' } },
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'content_type_blocked',
  );
});

test('fetchUrl: rejects PDF content-type', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://a.example.com/x.pdf',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 200, headers: { 'content-type': 'application/pdf' }, body: 'pdfbytes' } },
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'content_type_blocked',
  );
});

test('fetchUrl: accepts text/html, text/plain, application/json, text/markdown', async () => {
  const types: Array<[string, string]> = [
    ['text/html', '<title>T</title><p>html</p>'],
    ['text/plain', 'plain text'],
    ['application/json', '{"a":1}'],
    ['text/markdown', '# heading'],
  ];
  for (const [ct, body] of types) {
    const result = await fetchUrl({
      url: 'https://a.example.com/x',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 200, headers: { 'content-type': ct }, body } },
      ]),
    });
    assert.equal(result.contentType, ct, `expected ${ct} accepted`);
  }
});

test('fetchUrl: extracts <title> and strips tags from HTML', async () => {
  const result = await fetchUrl({
    url: 'https://a.example.com/x',
    resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
    httpRequest: makeHttpRequest([
      {
        response: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><head><title>The Article</title><script>alert(1)</script></head><body><h1>Hi</h1><p>Body text.</p></body></html>',
        },
      },
    ]),
  });
  assert.equal(result.title, 'The Article');
  assert.match(result.text, /Body text/);
  assert.equal(result.text.includes('alert(1)'), false, 'script content must be stripped');
});

// ── fetchUrl: body cap ───────────────────────────────────────────────────

test('fetchUrl: truncates body when oversized + sets truncated=true', async () => {
  const oversized = 'x'.repeat(500_000);
  const result = await fetchUrl({
    url: 'https://a.example.com/big',
    maxBytes: 200_000,
    resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
    httpRequest: makeHttpRequest([
      { response: { status: 200, headers: { 'content-type': 'text/plain' }, body: oversized } },
    ]),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.byteCount, 200_000);
});

test('fetchUrl: clamps maxBytes to HARD_MAX_BYTES (1MB)', async () => {
  const oversized = 'x'.repeat(2_000_000);
  const result = await fetchUrl({
    url: 'https://a.example.com/big',
    maxBytes: 99_999_999, // requested above HARD_MAX_BYTES
    resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
    httpRequest: makeHttpRequest([
      { response: { status: 200, headers: { 'content-type': 'text/plain' }, body: oversized } },
    ]),
  });
  assert.equal(result.byteCount, 1_000_000);
  assert.equal(result.truncated, true);
});

// ── fetchUrl: HTTP errors ────────────────────────────────────────────────

test('fetchUrl: surfaces 500 as http_error', async () => {
  await assert.rejects(
    () => fetchUrl({
      url: 'https://a.example.com',
      resolveHost: async () => ({ address: '8.8.8.8', family: 4 }),
      httpRequest: makeHttpRequest([
        { response: { status: 500, headers: { 'content-type': 'text/plain' }, body: 'oops' } },
      ]),
    }),
    (err) => err instanceof FetchError && err.code === 'http_error',
  );
});

// ── htmlToText unit ─────────────────────────────────────────────────────

test('htmlToText: drops <script>, <style>, <noscript>, comments', () => {
  const html = '<script>alert(1)</script><style>p{color:red}</style><!-- secret --><noscript>x</noscript><p>hello</p>';
  const out = htmlToText(html);
  assert.equal(out.text.includes('alert'), false);
  assert.equal(out.text.includes('secret'), false);
  assert.equal(out.text.includes('color:red'), false);
  assert.match(out.text, /hello/);
});

test('htmlToText: extracts <title>', () => {
  const out = htmlToText('<title>Hello World</title><p>body</p>');
  assert.equal(out.title, 'Hello World');
});

test('htmlToText: decodes basic entities', () => {
  const out = htmlToText('<p>caf&eacute; &amp; tea &lt;hot&gt;</p>');
  // We only decode named entities we know; unknown stays as-is. Important
  // is the safety-relevant ones (&lt;/&gt;) get unescaped so the LLM sees
  // them as text.
  assert.match(out.text, /tea <hot>/);
  assert.match(out.text, /&/);
});

// ── handleWeb (CLI envelope) ─────────────────────────────────────────────

test('handleWeb fetch: missing --url returns validation envelope', async () => {
  const out = await handleWeb(['fetch']);
  const env = JSON.parse(out);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'VALIDATION');
});

test('handleWeb fetch: invalid command returns validation', async () => {
  const out = await handleWeb(['unknown']);
  const env = JSON.parse(out);
  assert.equal(env.ok, false);
});
