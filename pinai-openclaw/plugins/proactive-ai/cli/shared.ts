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
