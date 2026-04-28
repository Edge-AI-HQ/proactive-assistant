/**
 * Loads the pin CLI reference from the canonical SKILL.md and exposes it as a
 * prompt-ready string. Single source of truth shared by:
 *   - OpenClaw skill loader (via /opt/pinai/skills/pin/SKILL.md)
 *   - This module, injected into the unified-generator phase 1 prompt
 *
 * Keep the SKILL.md in lockstep with cli/*.ts. Aspirational commands belong
 * in docs, not there.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// In container the plugin lives at /opt/pinai/plugins/proactive-ai/agents
// and the image-baked skill at /opt/pinai/skills/pin/SKILL.md.
// In dev (running from source) the plugin is at
// <repo>/pinai-openclaw/plugins/proactive-ai/agents and the skill is at
// <repo>/pinai-openclaw/image/skills/pin/SKILL.md.
const candidates = [
  resolve(here, '../../../skills/pin/SKILL.md'),        // container
  resolve(here, '../../../image/skills/pin/SKILL.md'),  // dev / source tree
];

function loadGuide(): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `pin SKILL.md not found. Looked at: ${candidates.join(', ')}`,
    );
  }
  const raw = readFileSync(found, 'utf8');
  // Strip the YAML frontmatter (between leading `---` lines) — frontmatter is
  // for OpenClaw's skill loader, not the LLM prompt.
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
  return `<pin_cli_command_guide>\n${body.trim()}\n</pin_cli_command_guide>`;
}

export const PIN_CLI_COMMAND_GUIDE = loadGuide();
