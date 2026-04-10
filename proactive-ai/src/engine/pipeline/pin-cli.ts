/**
 * pin-cli library wrapper.
 *
 * Calls runCli() in-process (no child_process needed).
 * Bridge between OpenClaw engine and the deterministic CLI tool layer.
 */

import { runCli } from '../../cli/cli.js';
import type { PinEnvelope } from '../../cli/output/envelope.js';
import { buildDefaultCtx } from './data-access.js';

export interface PinCliResult {
  ok: boolean;
  data: unknown;
  error: { type: string; code: string; message: string; hint?: string } | null;
  meta: { domain: string; command: string; requestId: string; timestamp: string };
}

export async function runPinCli(args: string[]): Promise<PinCliResult> {
  if (!args.includes('--json') && !args.includes('--format')) {
    args.push('--json');
  }

  const result = await runCli(args, { homeDir: buildDefaultCtx().homeDir });
  const envelope = result.stdout as PinEnvelope<unknown>;

  return {
    ok: envelope.ok,
    data: envelope.data,
    error: envelope.error,
    meta: envelope.meta,
  };
}

export async function pinCliData<T = unknown>(args: string[]): Promise<T> {
  const result = await runPinCli(args);
  if (!result.ok) {
    const hint = result.error?.hint ? ` (hint: ${result.error.hint})` : '';
    throw new Error(`pin-cli error: ${result.error?.message ?? 'unknown'}${hint}`);
  }
  return result.data as T;
}
