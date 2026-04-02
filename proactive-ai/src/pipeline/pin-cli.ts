/**
 * pin-cli shell wrapper.
 *
 * Executes `pin <args>` as a child process and returns parsed JSON output.
 * This is the bridge between OpenClaw agents and the deterministic pin-cli tool layer.
 *
 * Resolution order for the `pin` binary:
 * 1. `PIN_CLI_BIN` env var (explicit override)
 * 2. `pin` on $PATH (npm link / global install)
 * 3. Dev fallback: `npx tsx <repo>/pin-cli/src/bin.ts` (no build needed)
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PinCliResult {
  ok: boolean;
  data: unknown;
  error: { type: string; code: string; message: string; hint?: string } | null;
  meta: { domain: string; command: string; requestId: string; timestamp: string };
}

const TIMEOUT_MS = 30_000;

// ── Pin CLI resolution (cached) ──

interface ResolvedBin {
  bin: string;
  prefixArgs: string[];  // e.g. ['--import', 'tsx', 'src/bin.ts'] for dev mode
  cwd?: string;          // working directory for dev mode
}

let _resolved: ResolvedBin | undefined;

function resolvePinBin(): ResolvedBin {
  if (_resolved) return _resolved;

  // 1. Explicit override
  const explicit = process.env['PIN_CLI_BIN'];
  if (explicit) {
    _resolved = { bin: explicit, prefixArgs: [] };
    return _resolved;
  }

  // 2. Dev fallback: find pin-cli/src/bin.ts relative to this repo
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Walk up from proactive-ai/src/pipeline/ to repo root, then into pin-cli/
  const repoRoot = resolve(thisDir, '..', '..', '..');
  const pinCliBinTs = resolve(repoRoot, 'pin-cli', 'src', 'bin.ts');

  if (existsSync(pinCliBinTs)) {
    _resolved = {
      bin: process.execPath,  // node
      prefixArgs: ['--import', 'tsx', pinCliBinTs],
      cwd: resolve(repoRoot, 'pin-cli'),
    };
    return _resolved;
  }

  // 3. Assume `pin` is on $PATH
  _resolved = { bin: 'pin', prefixArgs: [] };
  return _resolved;
}

/**
 * Execute a pin-cli command and return the parsed result.
 *
 * @param command - Full command string, e.g. "profile get --id default"
 * @returns Parsed PinCliResult envelope
 */
export async function pinCli(command: string): Promise<PinCliResult> {
  const args = parseArgs(command);

  // Ensure --json is present for machine-readable output
  if (!args.includes('--json') && !args.includes('--format')) {
    args.push('--json');
  }

  const { bin, prefixArgs, cwd } = resolvePinBin();
  const fullArgs = [...prefixArgs, ...args];

  return new Promise((resolve, reject) => {
    execFile(bin, fullArgs, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, cwd }, (err, stdout, stderr) => {
      if (err && !stdout) {
        reject(new Error(`pin-cli exec failed: ${err.message}${stderr ? `\n${stderr}` : ''}`));
        return;
      }

      try {
        const result = JSON.parse(stdout) as PinCliResult;
        resolve(result);
      } catch {
        // Non-JSON output — wrap in a synthetic envelope
        resolve({
          ok: stdout.length > 0,
          data: stdout.trim(),
          error: stderr ? { type: 'internal', code: 'PARSE_ERROR', message: stderr.trim() } : null,
          meta: { domain: 'unknown', command, requestId: '', timestamp: new Date().toISOString() },
        });
      }
    });
  });
}

/**
 * Execute a pin-cli command and return just the data payload.
 * Throws on error.
 */
export async function pinCliData<T = unknown>(command: string): Promise<T> {
  const result = await pinCli(command);
  if (!result.ok) {
    const hint = result.error?.hint ? ` (hint: ${result.error.hint})` : '';
    throw new Error(`pin-cli error: ${result.error?.message ?? 'unknown'}${hint}`);
  }
  return result.data as T;
}

/**
 * Format a pin-cli command result as a human-readable string for agent consumption.
 */
export function formatForAgent(result: PinCliResult): string {
  if (!result.ok) {
    return `ERROR [${result.error?.code}]: ${result.error?.message}${result.error?.hint ? `\nHint: ${result.error.hint}` : ''}`;
  }
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
}

/**
 * Get a human-readable description of how pin-cli is resolved.
 * Useful for diagnostics / sys doctor.
 */
export function getPinCliInfo(): { mode: string; bin: string; cwd?: string } {
  const { bin, prefixArgs, cwd } = resolvePinBin();
  if (prefixArgs.length > 0) {
    return { mode: 'dev (tsx)', bin: `${bin} ${prefixArgs.join(' ')}`, cwd };
  }
  return { mode: process.env['PIN_CLI_BIN'] ? 'explicit (PIN_CLI_BIN)' : 'PATH', bin };
}

// ── Internals ──

function parseArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}
