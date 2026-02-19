import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import Docker from 'dockerode';
import type Dockerode from 'dockerode';
import { config } from '../config.js';
import { listUsedPorts, updateAssistant, updateUser, updateUserById } from '../db.js';
import type { AssistantRecord, UserRecord } from '../types.js';
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

type AssistantRuntimeRef = Pick<
  AssistantRecord,
  | 'id'
  | 'owner_telegram_user_id'
  | 'assistant_bot_id'
  | 'assistant_bot_token'
  | 'container_name'
  | 'container_id'
  | 'container_port'
>;

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

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const hasDesiredGatewayConfig = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const auth = isRecord(value.auth) ? value.auth : null;
  const controlUi = isRecord(value.controlUi) ? value.controlUi : null;
  const http = isRecord(value.http) ? value.http : null;
  const endpoints = http && isRecord(http.endpoints) ? http.endpoints : null;
  const chatCompletions = endpoints && isRecord(endpoints.chatCompletions) ? endpoints.chatCompletions : null;

  return (
    value.mode === 'local' &&
    value.port === config.openclaw.gatewayPort &&
    value.bind === 'lan' &&
    auth?.mode === 'token' &&
    auth?.token === config.openclaw.apiKey &&
    controlUi?.allowInsecureAuth === true &&
    chatCompletions?.enabled === true
  );
};

const hasDesiredTtsConfig = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return value.auto === 'off' && value.provider === 'elevenlabs';
};

const hasDesiredTelegramChannelConfig = (
  value: unknown,
  assistantBotToken: string
): boolean => {
  if (!isRecord(value)) return false;
  const actions = isRecord(value.actions) ? value.actions : null;
  const allowFrom = Array.isArray(value.allowFrom) ? value.allowFrom : null;
  const groupAllowFrom = Array.isArray(value.groupAllowFrom) ? value.groupAllowFrom : null;
  const groups = isRecord(value.groups) ? value.groups : null;
  const wildcardGroup = groups && isRecord(groups['*']) ? groups['*'] : null;
  const allowFromHasWildcard = Boolean(allowFrom?.some((entry) => String(entry).trim() === '*'));

  return (
    value.enabled === true &&
    value.dmPolicy === 'open' &&
    value.botToken === assistantBotToken &&
    allowFromHasWildcard &&
    groupAllowFrom?.length === 0 &&
    value.groupPolicy === 'open' &&
    wildcardGroup?.requireMention === true &&
    value.streamMode === 'partial' &&
    isBoolean(actions?.sendMessage) &&
    actions.sendMessage === true &&
    isBoolean(actions?.deleteMessage) &&
    actions.deleteMessage === false &&
    isBoolean(actions?.sticker) &&
    actions.sticker === true
  );
};

const withDesiredGatewayConfig = (root: UnknownRecord): void => {
  root.gateway = {
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
  };
};

const withDesiredTtsConfig = (root: UnknownRecord): void => {
  const existingMessages = isRecord(root.messages) ? root.messages : {};
  root.messages = {
    ...existingMessages,
    tts: {
      auto: 'off',
      provider: 'elevenlabs'
    }
  };
};

const withDesiredTelegramChannelConfig = (
  root: UnknownRecord,
  assistantBotToken: string
): void => {
  const existingChannels = isRecord(root.channels) ? root.channels : {};
  root.channels = {
    ...existingChannels,
    telegram: {
      enabled: true,
      dmPolicy: 'open',
      botToken: assistantBotToken,
      allowFrom: ['*'],
      groupAllowFrom: [],
      groupPolicy: 'open',
      groups: {
        '*': {
          requireMention: true
        }
      },
      streamMode: 'partial',
      actions: {
        sendMessage: true,
        deleteMessage: false,
        sticker: true
      }
    }
  };
};

const stripTelegramChannelConfig = (root: UnknownRecord): void => {
  if (!isRecord(root.channels)) return;
  const nextChannels: UnknownRecord = { ...root.channels };
  if (!Object.hasOwn(nextChannels, 'telegram')) return;
  delete nextChannels.telegram;
  if (Object.keys(nextChannels).length === 0) {
    delete root.channels;
    return;
  }
  root.channels = nextChannels;
};

const ensureOpenclawConfig = (
  configDir: string,
  assistantBotToken?: string | null
): { configPath: string; changed: boolean } => {
  const configPath = path.join(configDir, 'openclaw.json');

  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required to start OpenClaw gateway with LAN binding.');
  }

  const normalizedAssistantBotToken = (assistantBotToken || '').trim();
  const existingRaw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const existingParsed = (() => {
    if (!existingRaw) return {};
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();

  const hasGateway = hasDesiredGatewayConfig(existingParsed.gateway);
  const existingMessages = isRecord(existingParsed.messages) ? existingParsed.messages : null;
  const hasTts = hasDesiredTtsConfig(existingMessages?.tts);
  const existingChannels = isRecord(existingParsed.channels) ? existingParsed.channels : null;
  const hasTelegramChannel = normalizedAssistantBotToken
    ? hasDesiredTelegramChannelConfig(existingChannels?.telegram, normalizedAssistantBotToken)
    : !Object.hasOwn(existingChannels ?? {}, 'telegram');

  if (hasGateway && hasTts && hasTelegramChannel) {
    return { configPath, changed: false };
  }

  const next: UnknownRecord = { ...existingParsed };
  withDesiredGatewayConfig(next);
  withDesiredTtsConfig(next);
  if (normalizedAssistantBotToken) {
    withDesiredTelegramChannelConfig(next, normalizedAssistantBotToken);
  } else {
    stripTelegramChannelConfig(next);
  }

  const changed = JSON.stringify(existingParsed) !== JSON.stringify(next);
  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
  }
  return { configPath, changed };
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
    if (!entry.isDirectory()) return;
    const runtimeDataDir = path.join(dataDir, entry.name, 'data');
    if (!fs.existsSync(runtimeDataDir)) return;
    sanitizeCronStore(runtimeDataDir);
  });
};

export const containerNameForUser = (telegramUserId: number): string => `openclaw-user-${telegramUserId}`;
export const containerNameForAssistant = (assistantBotId: number): string => `openclaw-assistant-${assistantBotId}`;

const buildContainerDirs = (scopeDirName: string): UserContainerDirs => {
  const baseDir = path.join(process.cwd(), 'data', scopeDirName);
  return {
    configDir: path.join(baseDir, 'config'),
    dataDir: path.join(baseDir, 'data'),
    tmpDir: path.join(baseDir, 'tmp'),
    workspaceDir: path.join(baseDir, 'workspace')
  };
};

export const getUserContainerDirs = (telegramUserId: number): UserContainerDirs => {
  return buildContainerDirs(`user-${telegramUserId}`);
};

export const getAssistantContainerDirs = (assistantBotId: number): UserContainerDirs => {
  return buildContainerDirs(`assistant-${assistantBotId}`);
};

export const sanitizeUserCronStore = (telegramUserId: number): void => {
  if (isFlyRuntime()) return;
  const { dataDir } = getUserContainerDirs(telegramUserId);
  if (!fs.existsSync(dataDir)) return;
  sanitizeCronStore(dataDir);
};

export const sanitizeAssistantCronStore = (assistantBotId: number): void => {
  if (isFlyRuntime()) return;
  const { dataDir } = getAssistantContainerDirs(assistantBotId);
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

const findEnvValue = (envVars: string[] | undefined, key: string): string | null => {
  if (!Array.isArray(envVars)) return null;
  const prefix = `${key}=`;
  for (const variable of envVars) {
    if (!variable.startsWith(prefix)) continue;
    return variable.slice(prefix.length);
  }
  return null;
};

export const ensureUserContainer = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port' | 'assistant_bot_token'>
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
  const { changed: configChanged } = ensureOpenclawConfig(userConfigDir, user.assistant_bot_token);
  sanitizeCronStore(userDataDir);
  let shouldRestartForConfig = false;

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
    const legacyTelegramBotToken = findEnvValue(inspect?.Config?.Env, 'TELEGRAM_BOT_TOKEN');
    const needsEnvMigration = typeof legacyTelegramBotToken === 'string' && legacyTelegramBotToken.length > 0;

    if (needsBindMigration || needsEnvMigration) {
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
    } else if (configChanged && inspect.State?.Status === 'running') {
      shouldRestartForConfig = true;
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
  } else if (shouldRestartForConfig) {
    await container.restart();
  }

  const ready = await waitForPort(user.container_port, 30000);

  await updateUser(user.telegram_user_id, {
    container_status: ready ? 'running' : 'error'
  });

  return { containerId: container.id, ready };
};

export const ensureAssistantContainer = async (
  assistant: AssistantRuntimeRef
): Promise<{ containerId: string; ready: boolean }> => {
  if (isFlyRuntime()) {
    throw new Error('Fly runtime assistant provisioning is not supported.');
  }

  const fallbackContainerName = containerNameForAssistant(assistant.assistant_bot_id);
  const containerName = assistant.container_name?.trim() || fallbackContainerName;
  let container = await resolveContainer(assistant.container_id, containerName);

  const assistantDirs = getAssistantContainerDirs(assistant.assistant_bot_id);
  const assistantConfigDir = assistantDirs.configDir;
  const assistantDataDir = assistantDirs.dataDir;
  const assistantTmpDir = assistantDirs.tmpDir;
  const assistantWorkspaceDir = assistantDirs.workspaceDir;

  ensureDir(assistantConfigDir);
  ensureDir(assistantDataDir);
  ensureDir(assistantTmpDir);
  ensureDir(assistantWorkspaceDir);
  const { changed: configChanged } = ensureOpenclawConfig(assistantConfigDir, assistant.assistant_bot_token);
  sanitizeCronStore(assistantDataDir);
  let shouldRestartForConfig = false;

  if (container) {
    const inspect = await container.inspect();
    const binds = inspect?.HostConfig?.Binds;
    const expectedBinds: Array<{ target: string; source: string }> = [
      { target: '/app/config', source: assistantConfigDir },
      { target: '/app/data', source: assistantDataDir },
      { target: '/tmp', source: assistantTmpDir },
      { target: '/root/.openclaw/workspace', source: assistantWorkspaceDir }
    ];
    const needsBindMigration = expectedBinds.some(({ target, source }) => {
      const mountedSource = findBindSource(binds, target);
      return mountedSource !== source;
    });
    const legacyTelegramBotToken = findEnvValue(inspect?.Config?.Env, 'TELEGRAM_BOT_TOKEN');
    const needsEnvMigration = typeof legacyTelegramBotToken === 'string' && legacyTelegramBotToken.length > 0;

    if (needsBindMigration || needsEnvMigration) {
      try {
        if (inspect.State?.Status === 'running') {
          await container.stop();
        }
      } catch {
        // continue with forced remove
      }
      await container.remove({ force: true });
      container = null;
      await updateAssistant(assistant.id, {
        container_status: 'creating',
        container_id: '',
        container_name: containerName
      });
    } else if (configChanged && inspect.State?.Status === 'running') {
      shouldRestartForConfig = true;
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
        `OPENCLAW_USER_ID=assistant-${assistant.assistant_bot_id}`,
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
          [`${config.openclaw.gatewayPort}/tcp`]: [{ HostPort: String(assistant.container_port) }]
        },
        Binds: [
          `${assistantConfigDir}:/app/config`,
          `${assistantDataDir}:/app/data`,
          `${assistantTmpDir}:/tmp`,
          `${assistantWorkspaceDir}:/root/.openclaw/workspace`
        ],
        Memory: config.container.memoryMb * 1024 * 1024,
        CpuShares: config.container.cpuShares
      }
    });

    await updateAssistant(assistant.id, {
      container_status: 'creating',
      container_id: container.id,
      container_name: containerName
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
  } else if (shouldRestartForConfig) {
    await container.restart();
  }

  const ready = await waitForPort(assistant.container_port, 30000);
  await updateAssistant(assistant.id, {
    container_status: ready ? 'running' : 'error',
    container_name: containerName
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
