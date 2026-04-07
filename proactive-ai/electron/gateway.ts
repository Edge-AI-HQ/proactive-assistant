/**
 * Gateway lifecycle manager.
 *
 * Spawns `openclaw --profile proactive-ai gateway run` as a child process,
 * waits for health, and provides graceful shutdown.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import http from 'node:http';

const PROFILE = 'proactive-ai';
const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_TIMEOUT_MS = 60_000;

export interface OpenclawBin {
  /** Path to the openclaw CLI entry script (e.g. .../bin/openclaw) */
  script: string;
  /** Path to the Node binary that should run it (>= v22.12) */
  node: string;
}

export interface GatewayHandle {
  port: number;
  token: string;
  url: string;
  process: ChildProcess;
  kill(): Promise<void>;
}

/**
 * Find a free port on localhost.
 */
export function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

/**
 * Resolve the openclaw binary AND its companion Node.js binary.
 *
 * OpenClaw requires Node >= 22.12. We can't rely on the shell default `node`
 * being the right version (NVM, Volta, etc. may alias a different one).
 * Strategy:
 *   0. Bundled runtime inside packaged app (Contents/Resources/runtime/)
 *   1. Scan NVM versions for openclaw with Node >= 22.12
 *   2. Login shell `which openclaw` (Volta, Homebrew, etc.)
 */
export function resolveOpenclawBin(): OpenclawBin {
  const { homedir } = require('node:os');

  // Strategy 0: Bundled runtime (packaged Electron app)
  const bundled = resolveBundledRuntime();
  if (bundled) return bundled;

  // Strategy 1: Scan NVM versions for openclaw with Node >= 22.12
  const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    const found = scanNvmVersions(nvmDir);
    if (found) return found;
  }

  // Strategy 2: Login shell `which openclaw` (Volta, Homebrew, etc.)
  try {
    const script = execSync('bash -lc "which openclaw"', { encoding: 'utf-8' }).trim();
    const binDir = dirname(script);
    const node = join(binDir, 'node');
    if (existsSync(node)) {
      const ver = execSync(`"${node}" -v`, { encoding: 'utf-8' }).trim();
      if (nodeVersionOk(ver)) return { script, node };
    }
  } catch { /* fall through */ }

  throw new Error(
    'Could not find openclaw with Node >= 22.12.\n'
    + 'Please install it:  nvm use 22 && npm install -g openclaw',
  );
}

/**
 * Scan NVM node versions for one that has `openclaw` and Node 22.12+.
 * Prefer Node 22.x (same ABI as native modules compiled for the project).
 * Only fall back to Node 23+ if no 22.x is found.
 */
function scanNvmVersions(nvmDir: string): OpenclawBin | null {
  const { readdirSync } = require('node:fs');
  let versions: string[];
  try { versions = readdirSync(nvmDir); } catch { return null; }

  // Sort descending within each major to pick the highest minor
  versions.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));

  // First pass: prefer Node 22.x (ABI-compatible with most native modules)
  for (const ver of versions) {
    if (!nodeVersionInRange(ver, 22, 12)) continue;
    const script = join(nvmDir, ver, 'bin', 'openclaw');
    const node = join(nvmDir, ver, 'bin', 'node');
    if (existsSync(script) && existsSync(node)) return { script, node };
  }

  // Second pass: try any Node >= 22.12 (including 23+)
  for (const ver of versions) {
    if (!nodeVersionOk(ver)) continue;
    const script = join(nvmDir, ver, 'bin', 'openclaw');
    const node = join(nvmDir, ver, 'bin', 'node');
    if (existsSync(script) && existsSync(node)) return { script, node };
  }

  return null;
}

/** Check if version is Node `major`.`minMinor`+ (e.g. 22.12+) */
function nodeVersionInRange(ver: string, major: number, minMinor: number): boolean {
  const m = ver.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  return parseInt(m[1]!, 10) === major && parseInt(m[2]!, 10) >= minMinor;
}

/** Check if a version string meets the >= 22.12 requirement (any major) */
function nodeVersionOk(ver: string): boolean {
  const m = ver.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1]!, 10);
  const minor = parseInt(m[2]!, 10);
  return major > 22 || (major === 22 && minor >= 12);
}

/**
 * Look for Node + openclaw bundled inside the packaged Electron app.
 * Layout: Contents/Resources/runtime/{node, node_modules/.bin/openclaw}
 */
function resolveBundledRuntime(): OpenclawBin | null {
  // process.resourcesPath is only set in a packaged Electron app
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;

  const node = join(resourcesPath, 'runtime', 'node');
  const script = join(resourcesPath, 'runtime', 'node_modules', '.bin', 'openclaw');
  if (existsSync(node) && existsSync(script)) {
    console.log('[gateway] Using bundled runtime:', node);
    return { script, node };
  }
  return null;
}

/**
 * Start the OpenClaw gateway as a child process.
 */
export async function startGateway(
  bin: OpenclawBin,
  _pluginDir: string,
): Promise<GatewayHandle> {
  const port = await findAvailablePort();
  const token = randomUUID();

  // Spawn: node <openclaw-script> --profile proactive-ai gateway run ...
  const child = spawn(
    bin.node,
    [
      bin.script,
      '--profile', PROFILE,
      'gateway', 'run',
      '--port', String(port),
      '--bind', 'loopback',
      '--auth', 'token',
      '--token', token,
      '--force',
      '--allow-unconfigured',
    ],
    {
      env: {
        ...process.env,
        // Ensure child processes don't inherit ELECTRON_RUN_AS_NODE
        ELECTRON_RUN_AS_NODE: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Kill gateway if parent dies unexpectedly (SIGINT, SIGTERM, crash)
  const cleanup = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Log gateway output for debugging
  child.stdout?.on('data', (chunk: Buffer) => {
    console.log(`[gateway] ${chunk.toString().trimEnd()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[gateway] ${chunk.toString().trimEnd()}`);
  });

  child.on('error', (err) => {
    console.error('[gateway] Process error:', err.message);
  });

  // Wait for gateway to become healthy
  await pollHealth(port, token);

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    process: child,
    async kill() {
      if (child.killed) return;
      child.kill('SIGTERM');
      // Give it 5s to shut down gracefully, then force
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Poll the gateway health endpoint until it responds OK.
 */
function pollHealth(port: number, token: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Gateway did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s`));
        return;
      }

      const req = http.get(
        `http://127.0.0.1:${port}/proactive-ai/api/health`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 2_000,
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => { body += c.toString(); });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.ok) {
                resolve();
                return;
              }
            } catch { /* retry */ }
            setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
          });
        },
      );

      req.on('error', () => {
        setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
      });

      req.on('timeout', () => {
        req.destroy();
        setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
      });
    };

    attempt();
  });
}
