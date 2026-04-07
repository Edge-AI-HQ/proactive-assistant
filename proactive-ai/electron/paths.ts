/**
 * Centralized path resolution for Proactive AI desktop app.
 *
 * Single source of truth for locating the plugin directory, bundled
 * Node.js runtime, and openclaw binary in both dev and packaged modes.
 *
 * Packaged layout (inside .app bundle):
 *   Contents/Resources/
 *     app/dist/          ← compiled Electron code (__dirname)
 *     plugin/            ← proactive-ai plugin source + node_modules
 *     runtime/
 *       node             ← Node.js >= 22.12 binary
 *       node_modules/.bin/openclaw
 *
 * Dev layout (from repo checkout):
 *   proactive-ai/
 *     electron/dist/     ← __dirname
 *     index.ts, src/, …  ← plugin source (two levels up)
 *   (openclaw resolved from NVM / system PATH)
 */

import { app } from 'electron';
import { resolve, join } from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';

/** Whether the app is running from a packaged .app bundle. */
const PACKAGED = app.isPackaged;

/**
 * Root of the proactive-ai plugin directory.
 *
 * - Packaged: Contents/Resources/plugin/
 * - Dev:      proactive-ai/  (two levels up from electron/dist/)
 */
export function getPluginDir(): string {
  if (PACKAGED) {
    return join(process.resourcesPath, 'plugin');
  }
  // Dev: __dirname = proactive-ai/electron/dist/ → up two levels
  return resolve(__dirname, '..', '..');
}

/**
 * Root of the bundled runtime directory (packaged only).
 *
 * Contains the Node.js binary and openclaw installation.
 * Returns null in dev mode (uses system-installed openclaw).
 */
export function getBundledRuntimeDir(): string | null {
  if (!PACKAGED) return null;
  const dir = join(process.resourcesPath, 'runtime');
  return existsSync(dir) ? dir : null;
}

/**
 * Path to the bundled Node.js binary (packaged only).
 * Returns null in dev mode.
 */
export function getBundledNodeBin(): string | null {
  const runtimeDir = getBundledRuntimeDir();
  if (!runtimeDir) return null;
  const bin = join(runtimeDir, 'node');
  return existsSync(bin) ? bin : null;
}

/**
 * Path to the bundled openclaw CLI script (packaged only).
 *
 * Resolution order:
 *   1. node_modules/.bin/openclaw symlink (if it survived the copy)
 *   2. Resolve the symlink target manually via package.json "bin" field
 *   3. Common fallback: node_modules/openclaw/bin/openclaw.mjs
 *
 * Returns null in dev mode.
 */
export function getBundledOpenclawScript(): string | null {
  const runtimeDir = getBundledRuntimeDir();
  if (!runtimeDir) return null;

  // 1. Try the .bin symlink — works if Forge preserved it or it's a real file
  const binLink = join(runtimeDir, 'node_modules', '.bin', 'openclaw');
  if (existsSync(binLink)) {
    try {
      // Verify the symlink actually resolves to a real file
      realpathSync(binLink);
      return binLink;
    } catch {
      // Broken symlink — fall through
    }
  }

  // 2. Read the actual bin path from openclaw's package.json
  const openclawPkgPath = join(runtimeDir, 'node_modules', 'openclaw', 'package.json');
  if (existsSync(openclawPkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(openclawPkgPath, 'utf-8'));
      // "bin" can be string or { "openclaw": "./bin/openclaw.mjs" }
      const binEntry = typeof pkg.bin === 'string'
        ? pkg.bin
        : pkg.bin?.openclaw;
      if (binEntry) {
        const resolved = join(runtimeDir, 'node_modules', 'openclaw', binEntry);
        if (existsSync(resolved)) return resolved;
      }
    } catch {
      // Malformed package.json — fall through
    }
  }

  // 3. Common convention fallback
  for (const candidate of [
    join(runtimeDir, 'node_modules', 'openclaw', 'bin', 'openclaw.mjs'),
    join(runtimeDir, 'node_modules', 'openclaw', 'bin', 'openclaw'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
