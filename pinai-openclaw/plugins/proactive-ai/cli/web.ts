/**
 * `pin web fetch` — read-only HTTPS fetcher with SSRF defense.
 *
 * Tier 4 fallback for the chat agent: when an IntentCard source links to
 * a public URL (e.g. a Forbes article shared in Slack) the agent should
 * pull the text via this CLI instead of opening a browser. Browser is
 * heavier (session, captcha exposure, ToS) and unnecessary for plain
 * article reads.
 *
 * Safety rules (every one is a hard requirement, no opt-out):
 *   - HTTPS only (`http://` and other schemes refused).
 *   - DNS resolves to a public IP. localhost / link-local / RFC1918 /
 *     metadata IP / IPv6 unique-local / IPv6 link-local all refused. The
 *     check runs BEFORE the request (resolve, classify, then fetch with
 *     the IP locked) AND on every redirect hop.
 *   - At most 3 redirects. Each hop re-runs the IP classification.
 *   - Content-Type allowlist: text/html, text/plain, application/json,
 *     application/xhtml+xml, text/markdown. Everything else (binaries,
 *     PDFs, images) refused.
 *   - Body cap (default 200KB, max 1MB). Hard timeout (default 10s, max 30s).
 *
 * The CLI deliberately returns a JSON envelope, not raw HTML — research-loop
 * callers want `{ url, contentType, byteCount, truncated, title, text }`.
 * HTML-to-text is intentionally simple (drop script/style + collapse
 * whitespace); a richer extractor can be added later behind the same shape.
 */
import http from 'node:http';
import https from 'node:https';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { URL } from 'node:url';
import { success, failure, parseArgs, readNumericFlag } from './shared.js';

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  byteCount: number;
  truncated: boolean;
  title: string | null;
  text: string;
}

export interface FetchOpts {
  url: string;
  /** Maximum body bytes to read. Caller-controlled, bounded by HARD_MAX_BYTES. */
  maxBytes?: number;
  /** Hard timeout in ms. Caller-controlled, bounded by HARD_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test-only DNS injection. Production uses `dns.lookup`. */
  resolveHost?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }>;
  /** Test-only HTTP injection. Production uses `https.request`. */
  httpRequest?: typeof https.request;
}

const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const HARD_MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xhtml+xml',
]);

export class FetchError extends Error {
  constructor(public code: string, public hint: string | undefined, message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Classify an IPv4/IPv6 address as private / loopback / metadata. Returns
 * null when the address is fine to connect to. Returns a reason string
 * (suitable for the CLI envelope `error.message`) when blocked.
 *
 * The check is conservative — anything we can't decide on is treated as
 * unsafe. Adding network types to the allowlist requires a deliberate
 * decision (and a new test case here).
 */
export function classifyAddressForSsrf(address: string): { blocked: false } | { blocked: true; reason: string } {
  const family = net.isIP(address);
  if (family === 0) return { blocked: true, reason: `not a valid IP literal: ${address}` };

  if (family === 4) {
    const parts = address.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return { blocked: true, reason: `invalid IPv4: ${address}` };
    }
    const [a, b] = parts;
    if (a === 0) return { blocked: true, reason: `IPv4 0.0.0.0/8 (current network) blocked: ${address}` };
    if (a === 10) return { blocked: true, reason: `IPv4 10.0.0.0/8 (RFC1918) blocked: ${address}` };
    if (a === 127) return { blocked: true, reason: `IPv4 127.0.0.0/8 (loopback) blocked: ${address}` };
    if (a === 169 && b === 254) return { blocked: true, reason: `IPv4 169.254.0.0/16 (link-local / metadata) blocked: ${address}` };
    if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: `IPv4 172.16.0.0/12 (RFC1918) blocked: ${address}` };
    if (a === 192 && b === 168) return { blocked: true, reason: `IPv4 192.168.0.0/16 (RFC1918) blocked: ${address}` };
    if (a === 192 && b === 0 && parts[2] === 0) return { blocked: true, reason: `IPv4 192.0.0.0/24 (IETF) blocked: ${address}` };
    if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: `IPv4 100.64.0.0/10 (CGNAT) blocked: ${address}` };
    if (a >= 224) return { blocked: true, reason: `IPv4 multicast/reserved (≥224.0.0.0) blocked: ${address}` };
    return { blocked: false };
  }

  if (family === 6) {
    const lower = address.toLowerCase();
    // ::1 loopback (also written as ::0:0:0:0:0:0:0:1)
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
      return { blocked: true, reason: `IPv6 loopback (::1) blocked` };
    }
    // ::ffff:0:0/96 IPv4-mapped — strip and re-classify the v4
    const v4Mapped = lower.match(/^::ffff:([0-9a-f:.]+)$/);
    if (v4Mapped) {
      const inner = v4Mapped[1];
      if (inner.includes('.')) {
        return classifyAddressForSsrf(inner);
      }
      // hex form like ::ffff:7f00:1 — convert to dotted quad
      const parts = inner.split(':');
      if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return classifyAddressForSsrf(dotted);
      }
    }
    // fc00::/7 unique local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
      return { blocked: true, reason: `IPv6 unique-local (fc00::/7) blocked: ${address}` };
    }
    // fe80::/10 link local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) {
      return { blocked: true, reason: `IPv6 link-local (fe80::/10) blocked: ${address}` };
    }
    // ff00::/8 multicast
    if (lower.startsWith('ff')) {
      return { blocked: true, reason: `IPv6 multicast (ff00::/8) blocked: ${address}` };
    }
    return { blocked: false };
  }

  return { blocked: true, reason: `unknown IP family for: ${address}` };
}

async function defaultResolveHost(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  // dns.lookup uses the OS resolver (matches what node http would do).
  // Returns the first record so the SSRF check sees the same IP that the
  // socket will actually dial.
  const r = await dns.lookup(hostname);
  return { address: r.address, family: r.family as 4 | 6 };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  finalUrl: string;
}

async function executeRequest(
  url: URL,
  ip: string,
  family: 4 | 6,
  maxBytes: number,
  timeoutMs: number,
  httpRequestImpl: typeof https.request,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Pin the connection to the resolved IP so a second DNS lookup inside
    // the http stack can't race us to a different (potentially internal) IP.
    const req = httpRequestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      // node will do another lookup unless we provide `lookup`.
      lookup: (_h, _o, cb) => cb(null, ip, family),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        'User-Agent': 'pin-ai/web-fetch (research-loop)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
        'Accept-Language': 'en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      res.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const remaining = maxBytes - total;
        if (chunk.length <= remaining) {
          chunks.push(chunk);
          total += chunk.length;
        } else {
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            total += remaining;
          }
          truncated = true;
          // Drain the rest of the response so the socket closes cleanly.
          res.resume();
        }
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks, total),
          truncated,
          finalUrl: url.toString(),
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new FetchError('timeout', undefined, `request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * HTML → plain text. Deliberately minimal — drop scripts/styles/comments,
 * extract <title>, then strip remaining tags and collapse whitespace.
 * This is enough signal for the research-LLM to summarise; if it isn't,
 * upgrade to readability/jsdom in a follow-up.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  let stripped = html;
  // Drop script, style, comments. Each must be removed BEFORE tag stripping
  // because their bodies contain `<` / `>` characters that confuse a naive
  // tag stripper.
  stripped = stripped.replace(/<!--[\s\S]*?-->/g, ' ');
  stripped = stripped.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  stripped = stripped.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  stripped = stripped.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  stripped = stripped.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  let title: string | null = null;
  const titleMatch = stripped.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
  }

  stripped = stripped.replace(/<[^>]+>/g, ' ');
  stripped = decodeHtmlEntities(stripped);
  stripped = stripped.replace(/\s+/g, ' ').trim();
  return { title, text: stripped };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/**
 * Fetch + classify + parse — the main entry point exported for tests and
 * the research-loop runtime.
 */
export async function fetchUrl(opts: FetchOpts): Promise<FetchResult> {
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES));
  const timeoutMs = Math.max(1, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, HARD_MAX_TIMEOUT_MS));
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const httpRequestImpl = opts.httpRequest ?? https.request;

  let currentUrl: URL;
  try {
    currentUrl = new URL(opts.url);
  } catch (err) {
    throw new FetchError('invalid_url', 'pass a fully-qualified https:// URL', `invalid URL: ${opts.url}`);
  }

  const startUrl = currentUrl.toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (currentUrl.protocol !== 'https:') {
      throw new FetchError(
        'scheme_blocked',
        'only https:// URLs are allowed',
        `scheme ${currentUrl.protocol} blocked at hop ${hop}: ${currentUrl.toString()}`,
      );
    }
    if (!currentUrl.hostname) {
      throw new FetchError('invalid_url', undefined, `URL missing hostname at hop ${hop}`);
    }
    // Refuse hostname literals that look like raw IPs in the unsafe ranges
    // immediately, before DNS — this catches `https://127.0.0.1/` even
    // though dns.lookup would happily echo that back.
    if (net.isIP(currentUrl.hostname)) {
      const direct = classifyAddressForSsrf(currentUrl.hostname);
      if (direct.blocked) {
        throw new FetchError('ssrf_blocked', undefined, direct.reason);
      }
    }

    let resolved: { address: string; family: 4 | 6 };
    try {
      resolved = await resolveHost(currentUrl.hostname);
    } catch (err) {
      throw new FetchError(
        'dns_failed',
        undefined,
        `DNS lookup failed for ${currentUrl.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const classified = classifyAddressForSsrf(resolved.address);
    if (classified.blocked) {
      throw new FetchError('ssrf_blocked', undefined, classified.reason);
    }

    const raw = await executeRequest(currentUrl, resolved.address, resolved.family, maxBytes, timeoutMs, httpRequestImpl);

    // Redirect handling — re-validate every hop.
    if (raw.status >= 300 && raw.status < 400) {
      const loc = raw.headers['location'];
      if (typeof loc !== 'string' || loc.length === 0) {
        throw new FetchError('invalid_redirect', undefined, `${raw.status} response missing Location header`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new FetchError('too_many_redirects', undefined, `more than ${MAX_REDIRECTS} redirects`);
      }
      currentUrl = new URL(loc, currentUrl);
      continue;
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw new FetchError(
        'http_error',
        undefined,
        `HTTP ${raw.status} from ${currentUrl.toString()}`,
      );
    }

    const ctRaw = (raw.headers['content-type'] ?? '').toString();
    const ctMain = ctRaw.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(ctMain)) {
      throw new FetchError(
        'content_type_blocked',
        `allowed: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
        `content-type ${ctMain || '(missing)'} not in allowlist for ${currentUrl.toString()}`,
      );
    }

    const bodyText = raw.body.toString('utf8');
    let title: string | null = null;
    let text: string;
    if (ctMain === 'text/html' || ctMain === 'application/xhtml+xml') {
      const parsed = htmlToText(bodyText);
      title = parsed.title;
      text = parsed.text;
    } else if (ctMain === 'application/json') {
      // Pretty-print JSON so the research-LLM gets line breaks; truncation
      // already happened at the byte layer.
      try {
        text = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        text = bodyText;
      }
    } else {
      text = bodyText;
    }

    return {
      url: startUrl,
      finalUrl: currentUrl.toString(),
      status: raw.status,
      contentType: ctMain,
      byteCount: raw.body.length,
      truncated: raw.truncated,
      title,
      text,
    };
  }

  // Unreachable — the for-loop returns or throws on each iteration.
  throw new FetchError('too_many_redirects', undefined, 'redirect chain exhausted');
}

export async function handleWeb(args: string[]): Promise<string> {
  const { positional, flags } = parseArgs(args);
  const sub = positional[0];

  if (sub === 'fetch') {
    const url = flags['url'];
    if (!url) {
      return failure('web', 'fetch', 'validation', 'Missing --url', 'Pass --url <https-url>');
    }
    const maxBytesRes = readNumericFlag(flags, ['max-bytes'], 'web', 'fetch');
    if ('failure' in maxBytesRes) return maxBytesRes.failure;
    const timeoutRes = readNumericFlag(flags, ['timeout-ms'], 'web', 'fetch');
    if ('failure' in timeoutRes) return timeoutRes.failure;
    try {
      const result = await fetchUrl({
        url,
        maxBytes: maxBytesRes.value,
        timeoutMs: timeoutRes.value,
      });
      return success('web', 'fetch', result);
    } catch (err) {
      if (err instanceof FetchError) {
        return failure('web', 'fetch', err.code, err.message, err.hint);
      }
      const message = err instanceof Error ? err.message : String(err);
      return failure('web', 'fetch', 'internal', message);
    }
  }

  return failure('web', sub ?? 'unknown', 'validation',
    `Unknown web command: ${sub}`,
    'Available: fetch');
}
