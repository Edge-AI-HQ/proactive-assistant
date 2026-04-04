/**
 * pin-cli library wrapper.
 *
 * Calls pin-cli's `runCli()` in-process (no child_process needed).
 * This is the bridge between OpenClaw agents and the deterministic pin-cli tool layer.
 */

import { homedir } from 'node:os';
import { runCli } from '@pin-ai/pin-cli';
import type { PinEnvelope } from '@pin-ai/pin-cli/envelope';

export interface PinCliResult {
  ok: boolean;
  data: unknown;
  error: { type: string; code: string; message: string; hint?: string } | null;
  meta: { domain: string; command: string; requestId: string; timestamp: string };
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

  const result = await runCli(args, { homeDir: homedir() });
  const envelope = result.stdout as PinEnvelope<unknown>;

  return {
    ok: envelope.ok,
    data: envelope.data,
    error: envelope.error,
    meta: envelope.meta,
  };
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
export function getPinCliInfo(): { mode: string; bin: string } {
  return { mode: 'library (in-process)', bin: '@pin-ai/pin-cli' };
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
