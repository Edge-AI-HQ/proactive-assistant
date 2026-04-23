/**
 * Shared CLI utilities: output envelope, error handling.
 */

export interface CliEnvelope {
  ok: boolean;
  data: unknown;
  meta: { domain: string; command: string; timestamp: string };
  error: { type: string; code: string; message: string; hint?: string } | null;
}

export function success(domain: string, command: string, data: unknown): string {
  const envelope: CliEnvelope = {
    ok: true,
    data,
    meta: { domain, command, timestamp: new Date().toISOString() },
    error: null,
  };
  return JSON.stringify(envelope);
}

export function failure(domain: string, command: string, type: string, message: string, hint?: string): string {
  const envelope: CliEnvelope = {
    ok: false,
    data: null,
    meta: { domain, command, timestamp: new Date().toISOString() },
    error: { type, code: type.toUpperCase(), message, hint },
  };
  return JSON.stringify(envelope);
}

/** Parse --key value pairs from argv. Returns a map of flag->value. */
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * Strict number parse — Number('0.7+') / Number('abc') return NaN, which
 * would otherwise pass `typeof === 'number'` checks downstream and either
 * silently drop the flag or (worse) crash later via `new Date(NaN)`.
 * Returns undefined for missing or non-finite input.
 */
export function parseFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Accept --limit, --top, --max as aliases — agents reach for any of them. */
export function parseLimitFlag(flags: Record<string, string>): number | undefined {
  return parseFiniteNumber(flags['limit'] ?? flags['top'] ?? flags['max']);
}

/**
 * Read a numeric flag with validation. If the raw value is present but
 * non-finite, returns a failure envelope describing which flag is bad.
 * If the raw value is absent, returns { value: undefined }.
 */
export function readNumericFlag(
  flags: Record<string, string>,
  keys: string[],
  domain: string,
  command: string,
): { value: number | undefined } | { failure: string } {
  let raw: string | undefined;
  let seenKey: string | undefined;
  for (const k of keys) {
    if (flags[k] !== undefined) { raw = flags[k]; seenKey = k; break; }
  }
  if (raw === undefined) return { value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return {
      failure: failure(domain, command, 'validation',
        `Invalid --${seenKey} value (got "${raw}"); pass a plain number.`),
    };
  }
  return { value: n };
}

/** Same as readNumericFlag but for limit-style flags (accepts limit/top/max aliases). */
export function readLimitFlag(
  flags: Record<string, string>,
  domain: string,
  command: string,
): { value: number | undefined } | { failure: string } {
  return readNumericFlag(flags, ['limit', 'top', 'max'], domain, command);
}
