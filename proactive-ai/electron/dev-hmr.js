const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const electronDir = __dirname;
function findAvailablePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        server.close(() => reject(new Error('Failed to allocate a dev server port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function spawnManaged(command, args, options = {}) {
  return spawn(command, args, {
    stdio: 'inherit',
    detached: true,
    ...options,
  });
}

function terminateChild(child, signal = 'SIGTERM', forceAfterMs = 5_000) {
  if (!child || child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      finish();
    }, forceAfterMs);

    child.once('exit', () => {
      clearTimeout(timer);
      finish();
    });

    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  });
}

function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
      req.setTimeout(2_000, () => req.destroy());
    };

    attempt();
  });
}

async function main() {
  await run('npm', ['run', 'build'], { cwd: electronDir });

  const configuredDevServerUrl = process.env.PROACTIVE_AI_UI_DEV_SERVER;
  const devServerPort = configuredDevServerUrl
    ? Number(new URL(configuredDevServerUrl).port || 80)
    : await findAvailablePort();
  const uiDevServerUrl = configuredDevServerUrl || `http://127.0.0.1:${devServerPort}`;
  const uiDevHost = new URL(uiDevServerUrl).hostname || '127.0.0.1';
  const uiDevPort = String(new URL(uiDevServerUrl).port || devServerPort);

  const vite = spawnManaged('npm', ['run', 'dev:ui', '--', '--host', uiDevHost, '--port', uiDevPort, '--strictPort'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROACTIVE_AI_PROXY_TARGET: '',
      PROACTIVE_AI_GW_TOKEN: '',
    },
  });
  let electron = null;
  let shuttingDown = false;

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    await Promise.all([
      terminateChild(electron, 'SIGTERM'),
      terminateChild(vite, 'SIGTERM'),
    ]);

    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    shutdown(0).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdown(0).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });

  try {
    await waitForHttp(uiDevServerUrl);
  } catch (error) {
    await shutdown(1);
    throw error;
  }

  electron = spawnManaged('npm', ['run', 'start'], {
    cwd: electronDir,
    env: {
      ...process.env,
      PROACTIVE_AI_UI_DEV_SERVER: uiDevServerUrl,
    },
  });

  electron.on('exit', (code) => {
    shutdown(code ?? 0).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });

  vite.on('exit', (code) => {
    if (shuttingDown) return;
    shutdown(code ?? 0).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
