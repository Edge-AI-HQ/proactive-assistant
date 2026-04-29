/**
 * PIN CLI — Cloud edition (Supabase backend).
 * Same command interface as the standalone version.
 *
 * NOTE: shebang is added by esbuild --banner during Docker build.
 * Do not add #!/usr/bin/env node here — it causes duplicate shebangs.
 */

import { parseArgs, failure } from './shared.js';
import { handleProfile } from './profile.js';
import { handlePersonal } from './personal.js';
import { handleWorld } from './world.js';
import { handleFeedback } from './feedback.js';
import { handleSys } from './sys.js';
import { handleCards } from './cards.js';
// v3 memory architecture CLIs (see docs/plans/memory-architecture.mdx §六)
import { handleMemory } from './memory.js';
import { handleSignals } from './signals.js';
import { handleRaw } from './raw.js';
import { handleEvolution } from './evolution.js';
import { handleSkills } from './skills.js';
// background_tasks queue admin
// (docs/plans/2026-04-24-data-connector-init-tasks.mdx Phase A)
import { handleTasks } from './tasks.js';
import { isPublicCliCommand, publicCliDomains } from './public-surface.js';

const DOMAINS: Record<string, (args: string[]) => Promise<string>> = {
  profile: handleProfile,
  personal: handlePersonal,
  world: handleWorld,
  feedback: handleFeedback,
  cards: handleCards,
  sys: handleSys,
  // v3 domains
  memory: handleMemory,
  signals: handleSignals,
  raw: handleRaw,
  evolution: handleEvolution,
  skills: handleSkills,
  tasks: handleTasks,
};

function isInternalSurface(): boolean {
  return process.env.PIN_CLI_SURFACE === 'internal' || process.env.PIN_CLI_INTERNAL === '1';
}

function publicCommandLabel(domain: string, rest: string[]): string {
  const parts = [domain, ...parseArgs(rest).positional.slice(0, 2)];
  return `pin ${parts.join(' ')}`.trim();
}

function availableDomains(): string[] {
  return isInternalSurface() ? Object.keys(DOMAINS) : publicCliDomains();
}

function resultExitCode(result: string): number {
  try {
    const parsed = JSON.parse(result) as { ok?: unknown };
    return parsed.ok === false ? 1 : 0;
  } catch {
    return 0;
  }
}

async function main() {
  // Strip --json and --format flags (we always output JSON)
  const rawArgs = process.argv.slice(2).filter((a: string) => a !== '--json' && !a.startsWith('--format'));
  const domain = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (!domain || domain === '--help' || domain === '-h') {
    const domains = isInternalSurface() ? Object.keys(DOMAINS) : publicCliDomains();
    console.log(JSON.stringify({ ok: true, data: { domains }, meta: { domain: 'sys', command: 'help', timestamp: new Date().toISOString() }, error: null }));
    process.exit(0);
  }

  const handler = DOMAINS[domain];
  if (!handler) {
    console.log(failure('sys', 'dispatch', 'not_found', `Unknown domain: ${domain}`, `Available: ${availableDomains().join(', ')}`));
    process.exit(1);
  }
  if (!isInternalSurface() && !isPublicCliCommand(domain, rest)) {
    console.log(failure(
      domain,
      rest[0] ?? 'unknown',
      'forbidden',
      `${publicCommandLabel(domain, rest)} is not part of the public PCI CLI surface`,
      'Use `pin sys schema` to discover public commands. Set `PIN_CLI_SURFACE=internal` only for local/admin debugging.',
    ));
    process.exit(1);
  }

  try {
    const result = await handler(rest);
    console.log(result);
    process.exit(resultExitCode(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(failure(domain, rest[0] ?? 'unknown', 'internal', message));
    process.exit(1);
  }
}

main();
