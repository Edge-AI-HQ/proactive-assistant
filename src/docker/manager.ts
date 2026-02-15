import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import Docker from 'dockerode';
import type Dockerode from 'dockerode';
import { config } from '../config.js';
import { listUsedPorts, updateUser, updateUserById } from '../db.js';
import type { UserRecord } from '../types.js';
import {
  ensureUserMachine,
  getUserMachineLogs,
  getUserMachineStatus,
  resolveFlyGatewayTarget,
  restartUserMachine,
  stopUserMachine,
  type GatewayTarget
} from './fly.js';

const docker = new Docker();

const isFlyRuntime = (): boolean => config.container.runtime === 'fly';

type UnknownRecord = Record<string, unknown>;

interface ParsedCronStore {
  jobs: unknown[];
}

interface DockerStatusCodeError {
  statusCode?: number;
}

interface UserContainerDirs {
  configDir: string;
  dataDir: string;
  tmpDir: string;
  workspaceDir: string;
}

const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null;
};

const isStatusCodeError = (value: unknown): value is DockerStatusCodeError => {
  return isRecord(value) && typeof value.statusCode === 'number';
};

const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const ensureOpenclawConfig = (configDir: string): string => {
  const configPath = path.join(configDir, 'openclaw.json');

  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required to start OpenClaw gateway with LAN binding.');
  }

  const payload = {
    gateway: {
      mode: 'local',
      port: config.openclaw.gatewayPort,
      bind: 'lan',
      auth: {
        mode: 'token',
        token: config.openclaw.apiKey
      },
      controlUi: {
        allowInsecureAuth: true
      },
      http: {
        endpoints: {
          chatCompletions: { enabled: true }
        }
      }
    },
    messages: {
      tts: {
        auto: 'off',
        provider: 'elevenlabs'
      }
    }
  };

  if (fs.existsSync(configPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
      if (isRecord(existing) && JSON.stringify(existing) === JSON.stringify(payload)) {
        return configPath;
      }
    } catch {
      // fall through to rewrite config
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2));
  return configPath;
};

const parseCronStore = (raw: string): ParsedCronStore | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) return null;
    return { jobs: parsed.jobs };
  } catch {
    return null;
  }
};

const sanitizeCronStore = (userDataDir: string): void => {
  const cronPath = path.join(userDataDir, 'cron', 'jobs.json');
  if (!fs.existsSync(cronPath)) return;

  const parsed = parseCronStore(fs.readFileSync(cronPath, 'utf8'));
  if (!parsed) return;

  let changed = false;
  const jobs = parsed.jobs.map((job) => {
    if (!isRecord(job)) return job;
    const next: UnknownRecord = { ...job };

    if (isRecord(next.delivery) && next.delivery.mode !== 'none') {
      next.delivery = { ...next.delivery, mode: 'none' };
      changed = true;
    }

    if (isRecord(next.payload) && Object.hasOwn(next.payload, 'deliver') && next.payload.deliver !== false) {
      next.payload = { ...next.payload, deliver: false };
      changed = true;
    }

    return next;
  });

  if (!changed) return;

  const updated = {
    ...parsed,
    jobs
  };

  fs.writeFileSync(cronPath, `${JSON.stringify(updated, null, 2)}\n`);
};

export const sanitizeAllCronStores = (): void => {
  if (isFlyRuntime()) return;
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) return;

  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  entries.forEach((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('user-')) return;
    const userDataDir = path.join(dataDir, entry.name, 'data');
    if (!fs.existsSync(userDataDir)) return;
    sanitizeCronStore(userDataDir);
  });
};

export const containerNameForUser = (telegramUserId: number): string => `openclaw-user-${telegramUserId}`;

export const getUserContainerDirs = (telegramUserId: number): UserContainerDirs => {
  const baseDir = path.join(process.cwd(), 'data', `user-${telegramUserId}`);
  return {
    configDir: path.join(baseDir, 'config'),
    dataDir: path.join(baseDir, 'data'),
    tmpDir: path.join(baseDir, 'tmp'),
    workspaceDir: path.join(baseDir, 'workspace')
  };
};

export const sanitizeUserCronStore = (telegramUserId: number): void => {
  if (isFlyRuntime()) return;
  const { dataDir } = getUserContainerDirs(telegramUserId);
  if (!fs.existsSync(dataDir)) return;
  sanitizeCronStore(dataDir);
};

export const resolveContainerPathForUser = (telegramUserId: number, containerPath: string): string | null => {
  if (isFlyRuntime()) return null;
  if (!path.isAbsolute(containerPath)) return null;
  const dirs = getUserContainerDirs(telegramUserId);

  if (containerPath === '/app/data' || containerPath.startsWith('/app/data/')) {
    const relative = path.relative('/app/data', containerPath);
    return path.join(dirs.dataDir, relative);
  }

  if (containerPath === '/tmp' || containerPath.startsWith('/tmp/')) {
    const relative = path.relative('/tmp', containerPath);
    return path.join(dirs.tmpDir, relative);
  }

  if (containerPath === '/root/.openclaw/workspace' || containerPath.startsWith('/root/.openclaw/workspace/')) {
    const relative = path.relative('/root/.openclaw/workspace', containerPath);
    return path.join(dirs.workspaceDir, relative);
  }

  return null;
};

export const allocatePort = (): number => {
  const used = new Set(listUsedPorts());
  for (let port = config.container.portStart; port <= config.container.portEnd; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error('No available container ports in configured range');
};

const waitForPort = (port: number, timeoutMs = 30000): Promise<boolean> =>
  new Promise((resolve) => {
    const start = Date.now();

    const tryConnect = (): void => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(tryConnect, 1000);
        }
      });
    };

    tryConnect();
  });

export const resolveGatewayTargetForUser = (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port'>
): GatewayTarget => {
  if (isFlyRuntime()) {
    return resolveFlyGatewayTarget(user);
  }

  return {
    host: '127.0.0.1',
    port: user.container_port,
    httpBaseUrl: `http://127.0.0.1:${user.container_port}`,
    wsBaseUrl: `ws://127.0.0.1:${user.container_port}`
  };
};

const resolveContainer = async (
  containerId: string | null | undefined,
  fallbackName: string
): Promise<Dockerode.Container | null> => {
  if (containerId) {
    try {
      const container = docker.getContainer(containerId);
      await container.inspect();
      return container;
    } catch {
      // fall through to fallback lookup
    }
  }

  try {
    const container = docker.getContainer(fallbackName);
    await container.inspect();
    return container;
  } catch {
    return null;
  }
};

const findBindSource = (binds: string[] | undefined, target: string): string | null => {
  if (!Array.isArray(binds)) return null;
  for (const bind of binds) {
    const parts = bind.split(':');
    if (parts.length < 2) continue;
    const source = parts[0];
    const containerTarget = parts[1];
    if (containerTarget === target && source) {
      return source;
    }
  }
  return null;
};

export const ensureUserContainer = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port'>
): Promise<{ containerId: string; ready: boolean }> => {
  if (isFlyRuntime()) {
    return ensureUserMachine(user);
  }

  const containerName = containerNameForUser(user.telegram_user_id);
  let container = await resolveContainer(user.container_id, containerName);

  const userDirs = getUserContainerDirs(user.telegram_user_id);
  const userConfigDir = userDirs.configDir;
  const userDataDir = userDirs.dataDir;
  const userTmpDir = userDirs.tmpDir;
  const userWorkspaceDir = userDirs.workspaceDir;

  ensureDir(userConfigDir);
  ensureDir(userDataDir);
  ensureDir(userTmpDir);
  ensureDir(userWorkspaceDir);
  ensureOpenclawConfig(userConfigDir);
  sanitizeCronStore(userDataDir);

  if (container) {
    const inspect = await container.inspect();
    const binds = inspect?.HostConfig?.Binds;
    const expectedBinds: Array<{ target: string; source: string }> = [
      { target: '/app/config', source: userConfigDir },
      { target: '/app/data', source: userDataDir },
      { target: '/tmp', source: userTmpDir },
      { target: '/root/.openclaw/workspace', source: userWorkspaceDir }
    ];
    const needsBindMigration = expectedBinds.some(({ target, source }) => {
      const mountedSource = findBindSource(binds, target);
      return mountedSource !== source;
    });

    if (needsBindMigration) {
      try {
        if (inspect.State?.Status === 'running') {
          await container.stop();
        }
      } catch {
        // continue with forced remove
      }
      await container.remove({ force: true });
      container = null;
      await updateUser(user.telegram_user_id, {
        container_status: 'creating',
        container_id: ''
      });
    }
  }

  if (!container) {
    container = await docker.createContainer({
      name: containerName,
      Image: config.openclaw.image,
      Env: [
        `ANTHROPIC_API_KEY=${config.anthropicApiKey}`,
        ...(config.openaiApiKey ? [`OPENAI_API_KEY=${config.openaiApiKey}`] : []),
        ...(config.elevenLabs.apiKey ? [`ELEVENLABS_API_KEY=${config.elevenLabs.apiKey}`] : []),
        ...(config.elevenLabs.apiKey ? [`XI_API_KEY=${config.elevenLabs.apiKey}`] : []),
        ...(config.elevenLabs.baseUrl ? [`ELEVENLABS_BASE_URL=${config.elevenLabs.baseUrl}`] : []),
        `OPENCLAW_API_KEY=${config.openclaw.apiKey}`,
        ...(config.openclaw.braveApiKey ? [`BRAVE_API_KEY=${config.openclaw.braveApiKey}`] : []),
        `OPENCLAW_USER_ID=${user.telegram_user_id}`,
        `OPENCLAW_GATEWAY_PORT=${config.openclaw.gatewayPort}`,
        `OPENCLAW_GATEWAY_TOKEN=${config.openclaw.apiKey}`,
        'OPENCLAW_CONFIG_PATH=/app/config/openclaw.json',
        'OPENCLAW_STATE_DIR=/app/data'
      ],
      ExposedPorts: {
        [`${config.openclaw.gatewayPort}/tcp`]: {}
      },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: {
          [`${config.openclaw.gatewayPort}/tcp`]: [{ HostPort: String(user.container_port) }]
        },
        Binds: [
          `${userConfigDir}:/app/config`,
          `${userDataDir}:/app/data`,
          `${userTmpDir}:/tmp`,
          `${userWorkspaceDir}:/root/.openclaw/workspace`
        ],
        Memory: config.container.memoryMb * 1024 * 1024,
        CpuShares: config.container.cpuShares
      }
    });

    await updateUser(user.telegram_user_id, {
      container_status: 'creating',
      container_id: container.id
    });
  }

  const inspect = await container.inspect();
  if (inspect.State.Status !== 'running') {
    try {
      await container.start();
    } catch (error: unknown) {
      if (!isStatusCodeError(error) || error.statusCode !== 304) {
        throw error;
      }
    }
  }

  const ready = await waitForPort(user.container_port, 30000);

  await updateUser(user.telegram_user_id, {
    container_status: ready ? 'running' : 'error'
  });

  return { containerId: container.id, ready };
};

export const restartUserContainer = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>
): Promise<void> => {
  if (isFlyRuntime()) {
    await restartUserMachine(user);
    return;
  }

  const containerName = containerNameForUser(user.telegram_user_id);
  const container = await resolveContainer(user.container_id, containerName);
  if (!container) throw new Error('Container not found');
  await container.restart();
  await updateUser(user.telegram_user_id, { container_status: 'running' });
};

export const stopUserContainer = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>
): Promise<void> => {
  if (isFlyRuntime()) {
    await stopUserMachine(user);
    return;
  }

  const containerName = containerNameForUser(user.telegram_user_id);
  const container = await resolveContainer(user.container_id, containerName);
  if (!container) throw new Error('Container not found');
  await container.stop();
  await updateUser(user.telegram_user_id, { container_status: 'stopped' });
};

export const getUserContainerStatus = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>
): Promise<string> => {
  if (isFlyRuntime()) {
    return getUserMachineStatus(user);
  }

  const containerName = containerNameForUser(user.telegram_user_id);
  const container = await resolveContainer(user.container_id, containerName);
  if (!container) return 'missing';
  const inspect = await container.inspect();
  const status = inspect?.State?.Status || 'unknown';
  await updateUser(user.telegram_user_id, { container_status: status });
  return status;
};

export const getUserContainerLogs = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>,
  tail = 200
): Promise<string> => {
  if (isFlyRuntime()) {
    return getUserMachineLogs(user, tail);
  }

  const containerName = containerNameForUser(user.telegram_user_id);
  const container = await resolveContainer(user.container_id, containerName);
  if (!container) return '';
  const logs = await container.logs({ stdout: true, stderr: true, tail });
  return logs.toString('utf8');
};

export const updateContainerId = (userId: number, containerId: string): void => {
  updateUserById(userId, { container_id: containerId });
};
