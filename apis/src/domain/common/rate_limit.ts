/**
 * In-memory leaky bucket rate limiter, scoped per process. Cheap, no
 * external dependency, and correct under the workload we care about
 * (per-device / per-IP HTTP endpoints with low cardinality and short
 * windows).
 *
 * Caveats:
 *   - Process-local: if the API server is replicated, each replica has
 *     its own bucket. Effective limit = configured-limit × replica-count.
 *     Acceptable for current single-Fly-machine deployment; revisit when
 *     we horizontally scale.
 *   - No persistence: a restart wipes the buckets (devices get a fresh
 *     allowance immediately). That's the intended behaviour for soft
 *     anti-abuse, not an authentication mechanism.
 *
 * Use as Express middleware:
 *
 *   const limiter = createRateLimit({
 *     name: 'ingest',
 *     keyFn: (req) => req.header('x-device-id') ?? req.ip,
 *     capacity: 60, refillPerSec: 1,
 *   });
 *   router.post('/ingest', limiter, handler);
 */
import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  tokens: number;
  // Wall-clock ms when we last refilled, used to compute lazy fill on
  // each take() call.
  lastRefill: number;
}

export interface RateLimitOpts {
  /** Used in 429 response body + log line. */
  name: string;
  /** Function to derive the bucket key from the request. */
  keyFn: (req: Request) => string | undefined;
  /** Maximum tokens the bucket can hold. */
  capacity: number;
  /** Refill rate in tokens per second. */
  refillPerSec: number;
  /**
   * Optional: drop buckets whose lastRefill is older than this many ms.
   * Bounds memory under high cardinality / abusive traffic. Default: 1h.
   */
  evictAfterMs?: number;
}

interface Limiter {
  buckets: Map<string, Bucket>;
  opts: Required<RateLimitOpts>;
}

const DEFAULT_EVICT_AFTER_MS = 60 * 60 * 1000;

function createLimiter(opts: RateLimitOpts): Limiter {
  return {
    buckets: new Map<string, Bucket>(),
    opts: {
      ...opts,
      evictAfterMs: opts.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS,
    },
  };
}

function take(limiter: Limiter, key: string): boolean {
  const now = Date.now();
  let bucket = limiter.buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limiter.opts.capacity, lastRefill: now };
    limiter.buckets.set(key, bucket);
  } else {
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * limiter.opts.refillPerSec;
      bucket.tokens = Math.min(limiter.opts.capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Periodic GC: drop bucket rows that have been idle longer than
 * evictAfterMs. Called inline at low frequency (1/100 chance per take())
 * so we never need a setInterval — keeps the limiter side-effect-free
 * relative to module loading.
 */
function maybeEvict(limiter: Limiter): void {
  if (Math.random() > 0.01) return;
  const cutoff = Date.now() - limiter.opts.evictAfterMs;
  for (const [k, b] of limiter.buckets) {
    if (b.lastRefill < cutoff) limiter.buckets.delete(k);
  }
}

export interface RateLimitMiddleware {
  (req: Request, res: Response, next: NextFunction): void;
  /** Test hook: drop all buckets. */
  reset(): void;
  /** Test hook: take(key) without going through Express. */
  take(key: string): boolean;
}

export function createRateLimit(opts: RateLimitOpts): RateLimitMiddleware {
  const limiter = createLimiter(opts);

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const key = opts.keyFn(req);
    if (!key) {
      // No key means we can't bucket this caller — let it through but
      // log so a misconfigured route stays visible.
      console.warn(`[rate-limit:${opts.name}] no key for ${req.method} ${req.path}`);
      next();
      return;
    }
    maybeEvict(limiter);
    if (take(limiter, key)) {
      next();
      return;
    }
    res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMITED',
      limit: opts.name,
    });
  };

  // Attach test helpers as properties on the middleware fn itself.
  (middleware as RateLimitMiddleware).reset = () => limiter.buckets.clear();
  (middleware as RateLimitMiddleware).take = (key: string) => take(limiter, key);

  return middleware as RateLimitMiddleware;
}
