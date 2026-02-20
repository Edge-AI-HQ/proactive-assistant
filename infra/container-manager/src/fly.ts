import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { getContainerManagerRuntime } from './runtime.js';
import type { AssistantRecord, ContainerManagerConfig, ReadAssistantLiteLLMVirtualKey, UserRecord } from './types.js';

const config = new Proxy({} as ContainerManagerConfig, {
  get: (_target, prop) => getContainerManagerRuntime().config[prop as keyof ContainerManagerConfig]
});

const updateAssistant = (id: number, fields: Partial<AssistantRecord>) =>
  getContainerManagerRuntime().store.updateAssistant(id, fields);
const updateUser = (telegramUserId: number, fields: Partial<UserRecord>) =>
  getContainerManagerRuntime().store.updateUser(telegramUserId, fields);
const readAssistantLiteLLMVirtualKey: ReadAssistantLiteLLMVirtualKey = (assistant) =>
  getContainerManagerRuntime().readAssistantLiteLLMVirtualKey(assistant);

type UserRuntimeRef = Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port' | 'assistant_bot_token'>;
type AssistantRuntimeRef = Pick<
  AssistantRecord,
  | 'id'
  | 'assistant_bot_id'
  | 'assistant_bot_token'
  | 'litellm_virtual_key_encrypted'
  | 'container_name'
  | 'container_id'
  | 'container_port'
>;

type UnknownRecord = Record<string, unknown>;

export interface GatewayTarget {
  host: string;
  port: number;
  httpBaseUrl: string;
  wsBaseUrl: string;
}

interface FlyVolume {
  id: string;
  name: string;
  state?: string;
  host_status?: string;
  region?: string;
  created_at?: string;
  attached_machine_id?: string | null;
}

interface FlyMachineEvent {
  timestamp?: number | string;
  type?: string;
  status?: string;
  source?: string;
}

interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  private_ip?: string;
  created_at?: string;
  updated_at?: string;
  events?: FlyMachineEvent[];
  config?: {
    image?: string;
    env?: Record<string, string>;
    init?: {
      exec?: string[];
    };
    guest?: {
      cpus?: number;
      memory_mb?: number;
    };
  };
}

interface FlyExecResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  exit_signal?: number;
}

export interface FlyMachineArtifact {
  buffer: Buffer;
  filePath: string;
  fileName: string;
}

class FlyApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const FLY_REF_PREFIX = 'fly:';
const FLY_DEFAULT_PORT_TIMEOUT_MS = 120_000;
const FLY_MACHINE_WAIT_TIMEOUT_MS = 120_000;
const FLY_CREATE_RETRIES = 8;
const FLY_VOLUME_WAIT_TIMEOUT_MS = 45_000;
const FLY_EXEC_TIMEOUT_SECONDS = 60;
const FLY_ARTIFACT_MAX_BYTES = 15 * 1024 * 1024;
const FLY_ARTIFACT_HEADER = '__PINAI_PATH__:';
const FLY_ARTIFACT_SIZE_HEADER = '__PINAI_SIZE__:';
const FLY_ARTIFACT_CHUNK_BYTES = 1024 * 1024;
const FLY_ARTIFACT_EXEC_RETRIES = 4;
const FLY_DEPLOY_SYNC_CACHE_TTL_MS = 30_000;
const FLY_MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

interface RegistryAuthChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

interface ParsedImageDigestRef {
  registry: string;
  repository: string;
  digest: string;
}

interface MachineCreateArgs {
  machineName: string;
  openclawUserId: string;
  liteLlmApiKey: string | null;
  assistantBotToken?: string | null;
  ensureVolume: () => Promise<FlyVolume>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isFlyConfigured = (): boolean => Boolean(config.fly.apiToken && config.fly.appName);

const assertFlyConfigured = (): void => {
  if (!isFlyConfigured()) {
    throw new Error('FLY_API_TOKEN and FLY_APP_NAME are required when CONTAINER_RUNTIME=fly');
  }
};

const flyApiBase = (): string => config.fly.apiBaseUrl.replace(/\/+$/, '');

const formatHostForUrl = (host: string): string => {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
};

const parseFlyContainerRef = (value: string | null | undefined): { machineId: string; privateIp?: string } | null => {
  if (!value) return null;

  if (value.startsWith(FLY_REF_PREFIX)) {
    const payload = value.slice(FLY_REF_PREFIX.length);
    const [machineId, privateIpRaw] = payload.split('|', 2);
    const privateIp = privateIpRaw?.trim();
    if (!machineId) return null;
    return privateIp ? { machineId, privateIp } : { machineId };
  }

  if (
    value.startsWith('openclaw-user-') ||
    value.startsWith('openclaw-assistant-') ||
    value.startsWith('pinclaw-bot-')
  ) {
    return null;
  }
  return { machineId: value };
};

const encodeFlyContainerRef = (machineId: string, privateIp?: string): string =>
  privateIp ? `${FLY_REF_PREFIX}${machineId}|${privateIp}` : `${FLY_REF_PREFIX}${machineId}`;

const containerNameForUser = (telegramUserId: number): string => `openclaw-user-${telegramUserId}`;
const containerNameForAssistant = (assistantBotId: number): string => `pinclaw-bot-${assistantBotId}`;
const isUserMachineName = (name: string | undefined): boolean => Boolean(name?.startsWith('openclaw-user-'));
const isAssistantMachineName = (name: string | undefined): boolean =>
  Boolean(name?.startsWith('openclaw-assistant-') || name?.startsWith('pinclaw-bot-'));

const normalizeLiteLLMModelId = (value: string): string => value.trim().replace(/^litellm\//i, '');

const normalizeLiteLLMBaseUrlForOpenClaw = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
};

const inferReasoningByModelId = (id: string): boolean => {
  const normalized = id.toLowerCase();
  return (
    normalized.includes('thinking') ||
    normalized.includes('reason') ||
    normalized.includes('r1') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  );
};

const buildLiteLLMModelIds = (): string[] => {
  const ids: string[] = [];
  const pushUnique = (candidate: string): void => {
    const normalized = normalizeLiteLLMModelId(candidate);
    if (!normalized) return;
    if (!ids.includes(normalized)) ids.push(normalized);
  };

  pushUnique(config.litellm.openclawDefaultModel);
  config.litellm.allowedModels.forEach((model) => pushUnique(model));

  if (!ids.length) {
    ids.push('claude-opus-4-6');
  }
  return ids;
};

const buildLiteLLMPrimaryModelRef = (): string => `litellm/${buildLiteLLMModelIds()[0]}`;
const buildLiteLLMFallbackModelRefs = (): string[] => buildLiteLLMModelIds().slice(1).map((id) => `litellm/${id}`);

const buildLiteLLMProviderConfig = (apiKey: string): UnknownRecord => {
  const modelIds = buildLiteLLMModelIds();
  return {
    baseUrl: normalizeLiteLLMBaseUrlForOpenClaw(config.litellm.containerBaseUrl),
    apiKey,
    api: 'openai-completions',
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: inferReasoningByModelId(id),
      input: ['text', 'image'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 200000,
      maxTokens: 64000
    }))
  };
};

const resolveUserLiteLLMApiKey = (): string | null => {
  if (!config.litellm.enabled) return null;
  const key = config.litellm.masterKey.trim();
  if (!key) {
    throw new Error('LITELLM_MASTER_KEY is required when LiteLLM is enabled.');
  }
  return key;
};

const resolveAssistantLiteLLMApiKey = (assistant: AssistantRuntimeRef): string | null => {
  if (!config.litellm.enabled) return null;
  const key = readAssistantLiteLLMVirtualKey(assistant);
  if (!key) {
    throw new Error(`Assistant ${assistant.assistant_bot_id} missing LiteLLM virtual key`);
  }
  return key;
};

const buildFlyOpenclawConfig = (assistantBotToken: string, liteLlmApiKey: string | null): UnknownRecord => {
  const normalizedAssistantBotToken = assistantBotToken.trim();
  const normalizedLiteLLMApiKey = (liteLlmApiKey || '').trim();
  if (config.litellm.enabled && !normalizedLiteLLMApiKey) {
    throw new Error('LiteLLM is enabled but no API key is available for Fly OpenClaw config.');
  }

  const baseConfig: UnknownRecord = {
    gateway: {
      mode: 'local',
      port: config.openclaw.gatewayPort,
      // In Fly we keep gateway loopback-only and expose IPv6 via local proxy.
      // This avoids OpenClaw treating LAN self-connections as remote/pairing-required.
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: config.openclaw.apiKey
      },
      controlUi: {
        allowInsecureAuth: true
      },
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true
          }
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

  const elevenLabsApiKey = config.elevenLabs.apiKey.trim();
  if (elevenLabsApiKey) {
    const elevenlabs: UnknownRecord = { apiKey: elevenLabsApiKey };
    const elevenLabsBaseUrl = config.elevenLabs.baseUrl.trim();
    if (elevenLabsBaseUrl) {
      elevenlabs.baseUrl = elevenLabsBaseUrl;
    }
    baseConfig.messages = {
      tts: {
        auto: 'off',
        provider: 'elevenlabs',
        elevenlabs
      }
    };
    baseConfig.talk = { apiKey: elevenLabsApiKey };
  }

  if (config.litellm.enabled) {
    const models: UnknownRecord = {
      providers: {
        litellm: buildLiteLLMProviderConfig(normalizedLiteLLMApiKey)
      }
    };
    const nextModel: UnknownRecord = {
      primary: buildLiteLLMPrimaryModelRef()
    };
    const fallbackRefs = buildLiteLLMFallbackModelRefs();
    if (fallbackRefs.length) {
      nextModel.fallbacks = fallbackRefs;
    }
    baseConfig.models = models;
    baseConfig.agents = {
      defaults: {
        model: nextModel
      }
    };
  }

  if (normalizedAssistantBotToken) {
    baseConfig.channels = {
      telegram: {
        enabled: true,
        dmPolicy: 'open',
        botToken: normalizedAssistantBotToken,
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
    baseConfig.plugins = {
      entries: {
        telegram: {
          enabled: true
        }
      }
    };
  }

  return baseConfig;
};

const FLY_FORBIDDEN_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ELEVENLABS_API_KEY',
  'XI_API_KEY',
  'BRAVE_API_KEY',
  'LITELLM_API_KEY',
  'LITELLM_BASE_URL',
  'PINAI_LITELLM_BASE_URL',
  'OPENCLAW_API_KEY',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_CONFIG_JSON'
] as const;

const toTimestampMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

let latestAppDeployCache:
  | {
      updatedAtMs: number | null;
      expiresAt: number;
    }
  | null = null;
let ensureImagePullablePromise: Promise<void> | null = null;

const parseRegistryAuthChallenge = (rawHeader: string | null): RegistryAuthChallenge | null => {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;

  const params = trimmed.slice('bearer '.length);
  const entries = Array.from(params.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g));
  if (!entries.length) return null;

  const parsed: Partial<RegistryAuthChallenge> = {};
  entries.forEach((match) => {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) return;
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'realm') parsed.realm = value;
    if (lowerKey === 'service') parsed.service = value;
    if (lowerKey === 'scope') parsed.scope = value;
  });

  if (!parsed.realm) return null;
  return parsed as RegistryAuthChallenge;
};

const parseImageDigestRef = (rawImage: string): ParsedImageDigestRef | null => {
  const image = rawImage.trim();
  const atIndex = image.lastIndexOf('@');
  if (atIndex <= 0) return null;

  const digest = image.slice(atIndex + 1).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;

  const imageWithoutDigest = image.slice(0, atIndex).trim();
  if (!imageWithoutDigest) return null;

  const firstSlash = imageWithoutDigest.indexOf('/');
  const firstSegment = firstSlash >= 0 ? imageWithoutDigest.slice(0, firstSlash) : imageWithoutDigest;
  const hasExplicitRegistry = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';

  const registry = hasExplicitRegistry ? firstSegment.toLowerCase() : 'registry-1.docker.io';
  let repository = hasExplicitRegistry ? imageWithoutDigest.slice(firstSlash + 1) : imageWithoutDigest;
  if (!repository) return null;

  const lastSlash = repository.lastIndexOf('/');
  const lastColon = repository.lastIndexOf(':');
  if (lastColon > lastSlash) {
    repository = repository.slice(0, lastColon);
  }

  if (!repository) return null;
  if (registry === 'registry-1.docker.io' && !repository.includes('/')) {
    repository = `library/${repository}`;
  }

  return { registry, repository, digest };
};

const encodeRepositoryPath = (repository: string): string =>
  repository
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const registryAuthHeaderCandidates = (registry: string): Array<string | null> => {
  const flyToken = config.fly.apiToken.trim();
  if (!flyToken) return [null];

  if (registry === 'registry.fly.io' || registry.endsWith('.fly.io')) {
    const basicValue = Buffer.from(`x:${flyToken}`).toString('base64');
    return [`Bearer ${flyToken}`, `Basic ${basicValue}`, null];
  }

  return [null];
};

const requestRegistryAccessToken = async (
  challenge: RegistryAuthChallenge,
  registry: string
): Promise<string | null> => {
  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  if (challenge.scope) tokenUrl.searchParams.set('scope', challenge.scope);

  const authHeaders = registryAuthHeaderCandidates(registry);
  for (const authHeader of authHeaders) {
    const response = await fetch(tokenUrl, {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {})
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        continue;
      }
      continue;
    }

    const payload = (await response.json()) as { token?: string; access_token?: string };
    const token = (payload.token || payload.access_token || '').trim();
    if (token) return token;
  }

  return null;
};

const assertImageDigestPullable = async (imageRef: ParsedImageDigestRef): Promise<void> => {
  const manifestUrl = `https://${imageRef.registry}/v2/${encodeRepositoryPath(imageRef.repository)}/manifests/${imageRef.digest}`;

  const requestManifest = async (authHeader: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: FLY_MANIFEST_ACCEPT_HEADER
    };
    if (authHeader) headers.Authorization = authHeader;

    const head = await fetch(manifestUrl, { method: 'HEAD', headers });
    if (head.status !== 405) {
      return head;
    }

    return fetch(manifestUrl, { method: 'GET', headers });
  };

  const authHeaders = registryAuthHeaderCandidates(imageRef.registry);
  let lastStatus: number | null = null;
  let challenge: RegistryAuthChallenge | null = null;

  for (const authHeader of authHeaders) {
    const response = await requestManifest(authHeader);
    lastStatus = response.status;
    if (response.ok) return;
    if (response.status === 404) {
      throw new Error(`OPENCLAW_IMAGE digest not found in registry: ${config.openclaw.image}`);
    }
    if (response.status === 401) {
      challenge = parseRegistryAuthChallenge(response.headers.get('www-authenticate'));
    }
  }

  if (challenge) {
    const registryToken = await requestRegistryAccessToken(challenge, imageRef.registry);
    if (registryToken) {
      const retryResponse = await requestManifest(`Bearer ${registryToken}`);
      if (retryResponse.ok) return;
      if (retryResponse.status === 404) {
        throw new Error(`OPENCLAW_IMAGE digest not found in registry: ${config.openclaw.image}`);
      }
      lastStatus = retryResponse.status;
    }
  }

  throw new Error(
    `Failed to validate OPENCLAW_IMAGE digest pullability (${config.openclaw.image}). Registry returned status ${
      lastStatus ?? 'unknown'
    }.`
  );
};

const validateFlyImageDigest = async (): Promise<void> => {
  if (config.container.runtime !== 'fly') return;

  const imageRef = parseImageDigestRef(config.openclaw.image);
  if (!imageRef) {
    throw new Error(
      'When CONTAINER_RUNTIME=fly, OPENCLAW_IMAGE must be digest-pinned (example: registry.fly.io/<app>@sha256:<64-hex>).'
    );
  }

  await assertImageDigestPullable(imageRef);
};

export const ensureFlyOpenclawImageDigestPullable = async (): Promise<void> => {
  if (config.container.runtime !== 'fly') return;
  if (ensureImagePullablePromise) return ensureImagePullablePromise;

  const pending = validateFlyImageDigest().catch((error: unknown) => {
    if (ensureImagePullablePromise === pending) {
      ensureImagePullablePromise = null;
    }
    throw error;
  });

  ensureImagePullablePromise = pending;
  return pending;
};

const isAllowedArtifactPath = (value: string): boolean => {
  return (
    value === '/tmp' ||
    value.startsWith('/tmp/') ||
    value === '/app/data' ||
    value.startsWith('/app/data/') ||
    value === '/root/.openclaw/workspace' ||
    value.startsWith('/root/.openclaw/workspace/')
  );
};

const stripFileScheme = (value: string): string => {
  return value.startsWith('file://') ? value.slice('file://'.length) : value;
};

const artifactCandidatesForSource = (rawSource: string): string[] => {
  const source = stripFileScheme(rawSource.trim());
  if (!source || source.startsWith('..')) return [];

  const candidates: string[] = [];
  const pushCandidate = (candidate: string): void => {
    const normalized = path.posix.normalize(candidate.trim());
    if (!normalized || !isAllowedArtifactPath(normalized)) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  if (source.startsWith('/')) {
    pushCandidate(source);
    if (source.startsWith('/root/.openclaw/workspace/tmp/')) {
      pushCandidate(path.posix.join('/tmp', source.slice('/root/.openclaw/workspace/tmp/'.length)));
    }
    return candidates;
  }

  const relative = source.startsWith('./') ? source.slice(2) : source;
  if (!relative || relative.startsWith('..')) return [];

  pushCandidate(path.posix.join('/root/.openclaw/workspace', relative));
  pushCandidate(path.posix.join('/app/data', relative));
  if (relative.startsWith('tmp/')) {
    pushCandidate(path.posix.join('/tmp', relative.slice('tmp/'.length)));
  }

  return candidates;
};

const quoteForShell = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const hashConfigSha256 = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

const buildArtifactResolveScript = (candidates: string[]): string => {
  const quotedCandidates = candidates.map((item) => quoteForShell(item)).join(' ');
  return [
    `MAX_BYTES=${FLY_ARTIFACT_MAX_BYTES};`,
    'resolve_candidate() {',
    '  p="$1"',
    '  if [ -f "$p" ]; then',
    '    printf "%s" "$p"',
    '    return 0',
    '  fi',
    '  dir=$(dirname "$p")',
    '  base=$(basename "$p")',
    '  stem="${base%.*}"',
    '  ext="${base##*.}"',
    '  if [ ! -d "$dir" ] || [ "$stem" = "$base" ]; then',
    '    return 1',
    '  fi',
    '  for cutoff in 48 40 32 24 16; do',
    '    prefix=$(printf "%s" "$stem" | cut -c1-$cutoff)',
    '    [ -n "$prefix" ] || continue',
    '    for candidate in "$dir"/"$prefix"*; do',
    '      [ -f "$candidate" ] || continue',
    '      candidate_base=$(basename "$candidate")',
    '      candidate_ext="${candidate_base##*.}"',
    '      if [ "$candidate_ext" = "$ext" ]; then',
    '        printf "%s" "$candidate"',
    '        return 0',
    '      fi',
    '    done',
    '  done',
    '  newest=$(ls -1t "$dir"/*."$ext" 2>/dev/null | head -n 1)',
    '  if [ -n "$newest" ] && [ -f "$newest" ]; then',
    '    printf "%s" "$newest"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    `for p in ${quotedCandidates}; do`,
    '  resolved=$(resolve_candidate "$p") || continue',
    '  size=$(wc -c < "$resolved" 2>/dev/null || echo 0)',
    '  if [ "$size" -gt "$MAX_BYTES" ]; then echo "__PINAI_TOO_LARGE__:$resolved:$size" >&2; exit 9; fi',
    `  printf '${FLY_ARTIFACT_HEADER}%s\\n' "$resolved"`,
    `  printf '${FLY_ARTIFACT_SIZE_HEADER}%s\\n' "$size"`,
    '  exit 0',
    'done',
    'echo "__PINAI_NOT_FOUND__" >&2',
    'exit 4'
  ].join('\n');
};

const buildArtifactResolveByDirectoryScript = (directories: string[], extension: string): string => {
  const quotedDirs = directories.map((item) => quoteForShell(item)).join(' ');
  const quotedExt = quoteForShell(extension);
  return [
    `MAX_BYTES=${FLY_ARTIFACT_MAX_BYTES};`,
    `EXT=${quotedExt};`,
    `for d in ${quotedDirs}; do`,
    '  [ -d "$d" ] || continue',
    '  resolved=$(ls -1t "$d"/*."$EXT" 2>/dev/null | head -n 1)',
    '  [ -f "$resolved" ] || continue',
    '  size=$(wc -c < "$resolved" 2>/dev/null || echo 0)',
    '  if [ "$size" -gt "$MAX_BYTES" ]; then echo "__PINAI_TOO_LARGE__:$resolved:$size" >&2; exit 9; fi',
    `  printf '${FLY_ARTIFACT_HEADER}%s\\n' "$resolved"`,
    `  printf '${FLY_ARTIFACT_SIZE_HEADER}%s\\n' "$size"`,
    '  exit 0',
    'done',
    'echo "__PINAI_NOT_FOUND__" >&2',
    'exit 4'
  ].join('\n');
};

const extractMachineId = (user: Pick<UserRecord, 'container_id'>): string | null => {
  const parsed = parseFlyContainerRef(user.container_id);
  if (parsed?.machineId) return parsed.machineId;

  const normalized = (user.container_id || '').trim();
  if (normalized && !normalized.startsWith('openclaw-user-')) {
    return normalized;
  }
  return null;
};

const flyRequest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  assertFlyConfigured();

  const requestInit: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.fly.apiToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    }
  };
  if (body !== undefined) {
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(`${flyApiBase()}${path}`, requestInit);

  const raw = await response.text();
  if (!response.ok) {
    throw new FlyApiError(`Fly API ${method} ${path} failed (${response.status}): ${raw}`, response.status);
  }

  if (!raw) return null as T;
  return JSON.parse(raw) as T;
};

const isNotFoundError = (error: unknown): boolean => error instanceof FlyApiError && error.status === 404;

const isConflictOrPreconditionError = (error: unknown): error is FlyApiError =>
  error instanceof FlyApiError && (error.status === 409 || error.status === 412);

const isRetryableExecError = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError)) return false;
  return error.status === 429 || error.status >= 500;
};

const flyErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error || '')).toLowerCase();

const isMachineStartAlreadyInProgress = (error: unknown): boolean => {
  if (!isConflictOrPreconditionError(error)) return false;
  const message = flyErrorMessage(error);
  return (
    message.includes('still active') ||
    message.includes('refusing to start') ||
    message.includes('current state invalid') ||
    message.includes('unable to start machine from current state')
  );
};

const isMachineStopAlreadyInProgress = (error: unknown): boolean => {
  if (!isConflictOrPreconditionError(error)) return false;
  const message = flyErrorMessage(error);
  return message.includes('unable to stop machine') || message.includes('current state invalid');
};

const isVolumeNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError) || error.status !== 400) return false;
  return flyErrorMessage(error).includes('volume not found');
};

const isMachineNameConflict = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError) || error.status !== 409) return false;
  return flyErrorMessage(error).includes('name');
};

const isVolumeAlreadyExists = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError)) return false;
  if (error.status !== 409 && error.status !== 422) return false;
  return flyErrorMessage(error).includes('exists') || flyErrorMessage(error).includes('name');
};

const isInsufficientResourcesError = (error: unknown): boolean => {
  if (!(error instanceof FlyApiError)) return false;
  if (error.status !== 409 && error.status !== 412) return false;
  const message = flyErrorMessage(error);
  return message.includes('insufficient resources') || message.includes('insufficient memory');
};

const appPath = (): string => `/apps/${encodeURIComponent(config.fly.appName)}`;

const listMachines = async (): Promise<FlyMachine[]> => {
  return flyRequest<FlyMachine[]>('GET', `${appPath()}/machines`);
};

const getLatestAppDeployTimestampMs = async (): Promise<number | null> => {
  const now = Date.now();
  if (latestAppDeployCache && latestAppDeployCache.expiresAt > now) {
    return latestAppDeployCache.updatedAtMs;
  }

  const machines = await listMachines();
  let latest: number | null = null;

  machines.forEach((machine) => {
    if (isUserMachineName(machine.name) || isAssistantMachineName(machine.name)) return;
    const machineUpdatedAtMs = toTimestampMs(machine.updated_at) ?? toTimestampMs(machine.created_at);
    if (machineUpdatedAtMs === null) return;
    if (latest === null || machineUpdatedAtMs > latest) {
      latest = machineUpdatedAtMs;
    }
  });

  latestAppDeployCache = {
    updatedAtMs: latest,
    expiresAt: now + FLY_DEPLOY_SYNC_CACHE_TTL_MS
  };
  return latest;
};

const getMachine = async (machineId: string): Promise<FlyMachine> => {
  return flyRequest<FlyMachine>('GET', `${appPath()}/machines/${encodeURIComponent(machineId)}`);
};

const execMachine = async (machineId: string, command: string[], timeoutSec = 30): Promise<FlyExecResponse> => {
  return flyRequest<FlyExecResponse>('POST', `${appPath()}/machines/${encodeURIComponent(machineId)}/exec`, {
    command,
    timeout: Math.max(1, Math.min(FLY_EXEC_TIMEOUT_SECONDS, Math.ceil(timeoutSec)))
  });
};

const startMachine = async (machineId: string): Promise<void> => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await flyRequest<unknown>('POST', `${appPath()}/machines/${encodeURIComponent(machineId)}/start`);
      return;
    } catch (error: unknown) {
      if (!isMachineStartAlreadyInProgress(error)) {
        throw error;
      }
      if (attempt >= 5) return;
      await sleep(1000 * attempt);
    }
  }
};

const stopMachine = async (machineId: string): Promise<void> => {
  try {
    await flyRequest<unknown>('POST', `${appPath()}/machines/${encodeURIComponent(machineId)}/stop`);
  } catch (error: unknown) {
    if (isMachineStopAlreadyInProgress(error)) return;
    throw error;
  }
};

const destroyMachine = async (machineId: string): Promise<void> => {
  await flyRequest<unknown>('DELETE', `${appPath()}/machines/${encodeURIComponent(machineId)}?force=true`);
};

const listVolumes = async (): Promise<FlyVolume[]> => {
  return flyRequest<FlyVolume[]>('GET', `${appPath()}/volumes`);
};

const createVolume = async (name: string): Promise<FlyVolume> => {
  return flyRequest<FlyVolume>('POST', `${appPath()}/volumes`, {
    name,
    region: config.fly.region,
    size_gb: config.fly.volumeSizeGb
  });
};

const isVolumeReady = (volume: FlyVolume): boolean => {
  const state = (volume.state || '').toLowerCase();
  if (!state) return true;
  return state === 'created' || state === 'ready';
};

const sanitizeVolumePrefix = (value: string): string => {
  return value.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
};

const buildUserVolumeName = (telegramUserId: number): string => {
  const rawPrefix = (config.fly.volumeNamePrefix || 'openclaw_user').toLowerCase();
  const sanitizedPrefix = sanitizeVolumePrefix(rawPrefix) || 'openclaw_user';
  const suffix = String(telegramUserId).replace(/[^0-9]/g, '') || '0';
  const maxPrefixLength = Math.max(1, 30 - suffix.length - 1);
  const prefix = sanitizedPrefix.slice(0, maxPrefixLength).replace(/^_+|_+$/g, '') || 'u';
  const candidate = `${prefix}_${suffix}`;
  return candidate.slice(0, 30);
};

const buildAssistantVolumeName = (assistantBotId: number): string => {
  const rawPrefix = (config.fly.volumeNamePrefix || 'openclaw_user').toLowerCase();
  const withAssistantSuffix = `${rawPrefix}_assistant`;
  const sanitizedPrefix = sanitizeVolumePrefix(withAssistantSuffix) || 'openclaw_assistant';
  const suffix = String(assistantBotId).replace(/[^0-9]/g, '') || '0';
  const maxPrefixLength = Math.max(1, 30 - suffix.length - 1);
  const prefix = sanitizedPrefix.slice(0, maxPrefixLength).replace(/^_+|_+$/g, '') || 'a';
  const candidate = `${prefix}_${suffix}`;
  return candidate.slice(0, 30);
};

const ensureNamedVolume = async (name: string): Promise<FlyVolume> => {
  const selectPreferredVolume = (volumes: FlyVolume[]): FlyVolume | null => {
    const candidates = volumes.filter((item) => item.name === name);
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const aAttached = a.attached_machine_id ? 1 : 0;
      const bAttached = b.attached_machine_id ? 1 : 0;
      if (aAttached !== bAttached) return bAttached - aAttached;

      const aCreatedAt = toTimestampMs(a.created_at) ?? 0;
      const bCreatedAt = toTimestampMs(b.created_at) ?? 0;
      if (aCreatedAt !== bCreatedAt) return bCreatedAt - aCreatedAt;
      return b.id.localeCompare(a.id);
    });

    return candidates[0] ?? null;
  };

  const waitForVolumeReady = async (expectedId?: string): Promise<FlyVolume | null> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < FLY_VOLUME_WAIT_TIMEOUT_MS) {
      const volumes = await listVolumes();
      const existing = selectPreferredVolume(volumes);
      if (existing && (!expectedId || existing.id === expectedId) && isVolumeReady(existing)) return existing;
      await sleep(1000);
    }
    return null;
  };

  const volumes = await listVolumes();
  const existing = selectPreferredVolume(volumes);
  if (existing && isVolumeReady(existing)) return existing;
  if (existing?.id) {
    const existingReady = await waitForVolumeReady(existing.id);
    if (existingReady) return existingReady;
  }

  let created: FlyVolume | null = null;
  try {
    created = await createVolume(name);
  } catch (error: unknown) {
    if (!isVolumeAlreadyExists(error)) {
      throw error;
    }
  }

  if (created && isVolumeReady(created)) return created;

  const readyAfterCreate = await waitForVolumeReady(created?.id);
  if (readyAfterCreate) return readyAfterCreate;

  const fallbackVolumes = await listVolumes();
  const fallback = selectPreferredVolume(fallbackVolumes);
  if (fallback) return fallback;

  if (created) return created;
  throw new Error(`Fly volume ${name} is not ready`);
};

const ensureUserVolume = async (telegramUserId: number): Promise<FlyVolume> => {
  return ensureNamedVolume(buildUserVolumeName(telegramUserId));
};

const ensureAssistantVolume = async (assistantBotId: number): Promise<FlyVolume> => {
  return ensureNamedVolume(buildAssistantVolumeName(assistantBotId));
};

const toGatewayTarget = (host: string): GatewayTarget => {
  const urlHost = formatHostForUrl(host);
  const port = config.openclaw.gatewayPort;
  return {
    host,
    port,
    httpBaseUrl: `http://${urlHost}:${port}`,
    wsBaseUrl: `ws://${urlHost}:${port}`
  };
};

const resolveFromMachine = (machineId: string, privateIp?: string): GatewayTarget => {
  const host = privateIp || `${machineId}.vm.${config.fly.appName}.internal`;
  return toGatewayTarget(host);
};

export const resolveFlyGatewayTarget = (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>
): GatewayTarget => {
  const parsed = parseFlyContainerRef(user.container_id);
  if (!parsed?.machineId) {
    throw new Error(`Missing Fly machine ID for user ${user.telegram_user_id}`);
  }
  return resolveFromMachine(parsed.machineId, parsed.privateIp);
};

export const resolveFlyUserRuntimeRef = async (
  telegramUserId: number
): Promise<Pick<UserRecord, 'telegram_user_id' | 'container_id' | 'container_port' | 'assistant_bot_token'> | null> => {
  if (!isFlyConfigured()) return null;

  const machines = await listMachines();
  const machine = machines.find((item) => item.name === containerNameForUser(telegramUserId));
  if (!machine?.id) return null;

  return {
    telegram_user_id: telegramUserId,
    container_id: encodeFlyContainerRef(machine.id, machine.private_ip),
    // Not used by Fly runtime, but required by shared user runtime type.
    container_port: 0,
    assistant_bot_token: null
  };
};

const waitForPort = (host: string, port: number, timeoutMs = FLY_DEFAULT_PORT_TIMEOUT_MS): Promise<boolean> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const scheduleRetry = (): void => {
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      setTimeout(tryConnect, 1000);
    };

    const tryConnect = (): void => {
      if (settled) return;
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        finish(true);
      });

      socket.setTimeout(3000);

      socket.on('timeout', () => {
        socket.destroy();
        scheduleRetry();
      });

      socket.on('error', () => {
        socket.destroy();
        scheduleRetry();
      });
    };

    tryConnect();
  });

const connectProbeRequestId = 'fly-gateway-probe-connect';

const probeGatewayHelloOnce = async (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const wsUrl = `ws://${formatHostForUrl(host)}:${port}`;
    const ws = new WebSocket(wsUrl, { maxPayload: 2 * 1024 * 1024 });
    let settled = false;
    let sent = false;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close failures during probe
      }
      resolve(ok);
    };

    const sendConnect = (): void => {
      if (sent) return;
      sent = true;
      const params = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          version: 'dev',
          platform: process.platform,
          mode: 'backend',
          instanceId: 'fly-gateway-probe'
        },
        role: 'operator',
        scopes: ['operator.admin'],
        caps: ['tool-events'],
        commands: [],
        permissions: {},
        auth: {
          token: config.openclaw.apiKey
        },
        userAgent: 'pinai-telegram-bot',
        locale: 'en-US'
      };
      ws.send(
        JSON.stringify({
          type: 'req',
          id: connectProbeRequestId,
          method: 'connect',
          params
        })
      );
    };

    const timeout = setTimeout(() => finish(false), 5000);
    timeout.unref();

    ws.on('open', () => {
      sendConnect();
    });

    ws.on('message', (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;
      const data = payload as Record<string, unknown>;
      if (data.type === 'res' && data.id === connectProbeRequestId) {
        clearTimeout(timeout);
        finish(Boolean(data.ok));
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      finish(false);
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
  });

const waitForGatewayHello = async (host: string, port: number, timeoutMs: number): Promise<boolean> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await probeGatewayHelloOnce(host, port);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
};

const waitForMachineState = async (
  machineId: string,
  desired: Set<string>,
  timeoutMs = 45_000
): Promise<FlyMachine> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const machine = await getMachine(machineId);
    const state = (machine.state || '').toLowerCase();
    if (desired.has(state)) return machine;
    if (state === 'destroyed') return machine;
    await sleep(1000);
  }
  return getMachine(machineId);
};

const normalizeMachineState = (machine: FlyMachine): string => {
  const state = (machine.state || '').toLowerCase();
  if (state === 'started' || state === 'running') return 'running';
  if (state === 'stopped') return 'stopped';
  if (state === 'created' || state === 'starting') return 'creating';
  if (state === 'destroyed') return 'missing';
  return state || 'unknown';
};

const normalizeAssistantToken = (value: string | null | undefined): string => (value || '').trim();

const machineNeedsRecreate = (
  machine: FlyMachine,
  latestAppDeployAtMs: number | null,
  desiredAssistantBotToken?: string | null,
  desiredLiteLLMApiKey?: string | null
): boolean => {
  const configuredImage = machine.config?.image?.trim();
  if (configuredImage && configuredImage !== config.openclaw.image) {
    return true;
  }
  const configuredMemoryMb = machine.config?.guest?.memory_mb;
  if (typeof configuredMemoryMb === 'number' && configuredMemoryMb !== config.container.memoryMb) {
    return true;
  }
  const configuredCpus = machine.config?.guest?.cpus;
  if (typeof configuredCpus === 'number' && configuredCpus !== Math.max(1, config.fly.machineCpus)) {
    return true;
  }

  const desiredToken = normalizeAssistantToken(desiredAssistantBotToken);
  const desiredOpenclawConfig = buildFlyOpenclawConfig(desiredToken, desiredLiteLLMApiKey || null);
  const desiredConfigHash = hashConfigSha256(JSON.stringify(desiredOpenclawConfig));
  const currentEnv = machine.config?.env;
  const currentConfigHash = currentEnv?.PINAI_OPENCLAW_CONFIG_SHA256;
  if (typeof currentConfigHash !== 'string' || currentConfigHash.trim() !== desiredConfigHash) {
    return true;
  }
  if (currentEnv?.TELEGRAM_BOT_TOKEN) {
    return true;
  }
  if (currentEnv) {
    const hasSecretEnv = FLY_FORBIDDEN_SECRET_ENV_KEYS.some((key) => {
      const value = currentEnv[key];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (hasSecretEnv) {
      return true;
    }
  }

  if (currentEnv?.OPENCLAW_CONFIG_PATH !== '/app/data/config/openclaw.json') {
    return true;
  }

  const initExec = machine.config?.init?.exec;
  if (!Array.isArray(initExec) || initExec.length === 0) return false;
  const joined = initExec.join(' ');
  const legacyConfig =
    !joined.includes('[fly-ipv6-proxy]') ||
    !joined.includes('openclaw gateway --bind loopback');
  if (legacyConfig) return true;

  if (latestAppDeployAtMs === null) return false;
  const machineUpdatedAtMs = toTimestampMs(machine.updated_at) ?? toTimestampMs(machine.created_at);
  if (machineUpdatedAtMs === null) return false;

  return machineUpdatedAtMs < latestAppDeployAtMs;
};

const resolveMachineByRef = async (containerId: string | null | undefined, fallbackNames: string[]): Promise<FlyMachine | null> => {
  const ref = parseFlyContainerRef(containerId);
  if (ref?.machineId) {
    try {
      return await getMachine(ref.machineId);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  const fallbackNameSet = new Set(fallbackNames.map((item) => item.trim()).filter(Boolean));
  if (!fallbackNameSet.size) return null;
  const machines = await listMachines();
  const byName = machines.find((machine) => machine.name && fallbackNameSet.has(machine.name));
  return byName ?? null;
};

const resolveUserMachine = async (user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>): Promise<FlyMachine | null> => {
  return resolveMachineByRef(user.container_id, [containerNameForUser(user.telegram_user_id)]);
};

const resolveAssistantMachineName = (assistant: AssistantRuntimeRef): string => {
  return assistant.container_name?.trim() || containerNameForAssistant(assistant.assistant_bot_id);
};

const resolveAssistantMachine = async (assistant: AssistantRuntimeRef): Promise<FlyMachine | null> => {
  const fallbackNames = Array.from(
    new Set(
      [assistant.container_name?.trim(), containerNameForAssistant(assistant.assistant_bot_id)].filter(
        (value): value is string => Boolean(value)
      )
    )
  );
  return resolveMachineByRef(assistant.container_id, fallbackNames);
};

const createMachine = async (args: MachineCreateArgs): Promise<FlyMachine> => {
  const normalizedAssistantBotToken = normalizeAssistantToken(args.assistantBotToken);
  const openclawConfig = buildFlyOpenclawConfig(normalizedAssistantBotToken, args.liteLlmApiKey);
  const openclawConfigJson = JSON.stringify(openclawConfig);
  const openclawConfigHash = hashConfigSha256(openclawConfigJson);

  const env: Record<string, string> = {
    OPENCLAW_USER_ID: args.openclawUserId,
    OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
    OPENCLAW_CONFIG_PATH: '/app/data/config/openclaw.json',
    OPENCLAW_STATE_DIR: '/app/data',
    PINAI_OPENCLAW_CONFIG_SHA256: openclawConfigHash
  };
  const bootstrapCommand = [
    'mkdir -p /app/data/workspace /app/data/tmp /app/data/config /root/.openclaw',
    `printf "%s" ${quoteForShell(openclawConfigJson)} > "$OPENCLAW_CONFIG_PATH"`,
    'ln -sfn /app/data/workspace /root/.openclaw/workspace',
    `node -e 'const net=require("net");const port=Number(process.env.OPENCLAW_GATEWAY_PORT||${config.openclaw.gatewayPort});const server=net.createServer((inbound)=>{const outbound=net.connect({host:"127.0.0.1",port});inbound.pipe(outbound);outbound.pipe(inbound);const close=()=>{inbound.destroy();outbound.destroy();};inbound.on("error",close);outbound.on("error",close);});server.on("error",(err)=>{console.error("[fly-ipv6-proxy] fatal",err);process.exit(1);});server.listen({host:"::",port,ipv6Only:true},()=>{console.log(\`[fly-ipv6-proxy] listening on [::]:\${port} -> 127.0.0.1:\${port}\`);});' >/tmp/fly-ipv6-proxy.log 2>&1 & sleep 0.2`,
    'exec openclaw gateway --bind loopback'
  ].join(' && ');

  const machineName = args.machineName;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= FLY_CREATE_RETRIES; attempt += 1) {
    const volume = await args.ensureVolume();

    try {
      return await flyRequest<FlyMachine>('POST', `${appPath()}/machines`, {
        name: machineName,
        config: {
          image: config.openclaw.image,
          env,
          guest: {
            cpu_kind: 'shared',
            cpus: Math.max(1, config.fly.machineCpus),
            memory_mb: config.container.memoryMb
          },
          mounts: [{ volume: volume.id, path: '/app/data' }],
          restart: {
            policy: 'on-failure',
            max_retries: 3
          },
          init: {
            exec: ['sh', '-lc', bootstrapCommand]
          }
        }
      });
    } catch (error: unknown) {
      lastError = error;

      if (isMachineNameConflict(error)) {
        const machines = await listMachines();
        const existing = machines.find((machine) => machine.name === machineName);
        if (existing) return existing;
      }

      if (isInsufficientResourcesError(error) && attempt < FLY_CREATE_RETRIES) {
        await sleep(1000 * attempt);
        continue;
      }

      if (!isVolumeNotFoundError(error) || attempt >= FLY_CREATE_RETRIES) {
        throw error;
      }

      await sleep(1000 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Fly machine creation failed');
};

const createUserMachine = async (user: UserRuntimeRef, liteLlmApiKey = resolveUserLiteLLMApiKey()): Promise<FlyMachine> => {
  return createMachine({
    machineName: containerNameForUser(user.telegram_user_id),
    openclawUserId: String(user.telegram_user_id),
    liteLlmApiKey,
    assistantBotToken: user.assistant_bot_token,
    ensureVolume: () => ensureUserVolume(user.telegram_user_id)
  });
};

const createAssistantMachine = async (
  assistant: AssistantRuntimeRef,
  liteLlmApiKey = resolveAssistantLiteLLMApiKey(assistant)
): Promise<FlyMachine> => {
  return createMachine({
    machineName: resolveAssistantMachineName(assistant),
    openclawUserId: `assistant-${assistant.assistant_bot_id}`,
    liteLlmApiKey,
    assistantBotToken: assistant.assistant_bot_token,
    ensureVolume: () => ensureAssistantVolume(assistant.assistant_bot_id)
  });
};

const persistUserMachineRef = async (userId: number, machine: FlyMachine): Promise<string> => {
  const encoded = encodeFlyContainerRef(machine.id, machine.private_ip);
  await updateUser(userId, {
    container_id: encoded
  });
  return encoded;
};

const persistAssistantMachineRef = async (assistantId: number, fallbackName: string, machine: FlyMachine): Promise<string> => {
  const encoded = encodeFlyContainerRef(machine.id, machine.private_ip);
  await updateAssistant(assistantId, {
    container_id: encoded,
    container_name: machine.name?.trim() || fallbackName
  });
  return encoded;
};

const ensureUserInFlight = new Map<number, Promise<{ containerId: string; ready: boolean }>>();
const ensureAssistantInFlight = new Map<number, Promise<{ containerId: string; ready: boolean }>>();

const runEnsureUserMachine = async (user: UserRuntimeRef): Promise<{ containerId: string; ready: boolean }> => {
  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required to start OpenClaw on Fly runtime.');
  }
  const desiredLiteLLMApiKey = resolveUserLiteLLMApiKey();
  await ensureFlyOpenclawImageDigestPullable();

  let machine = await resolveUserMachine(user);
  if (machine) {
    const previous = machine;
    machine = await getMachine(machine.id);
    if (!machine.updated_at && previous.updated_at) {
      machine.updated_at = previous.updated_at;
    }
    if (!machine.created_at && previous.created_at) {
      machine.created_at = previous.created_at;
    }

    let latestAppDeployAtMs: number | null = null;
    try {
      latestAppDeployAtMs = await getLatestAppDeployTimestampMs();
    } catch (error: unknown) {
      console.warn('Failed to resolve latest app deployment timestamp', error);
    }

    if (machineNeedsRecreate(machine, latestAppDeployAtMs, user.assistant_bot_token, desiredLiteLLMApiKey)) {
      await destroyMachine(machine.id);
      machine = null;
      await updateUser(user.telegram_user_id, {
        container_status: 'creating',
        container_id: ''
      });
    }
  }

  if (!machine) {
    machine = await createUserMachine(user, desiredLiteLLMApiKey);
  }

  let currentState = normalizeMachineState(machine);
  if (currentState === 'missing') {
    await updateUser(user.telegram_user_id, {
      container_status: 'creating',
      container_id: ''
    });
    machine = await createUserMachine(user, desiredLiteLLMApiKey);
    currentState = normalizeMachineState(machine);
  }

  if (currentState !== 'running') {
    await startMachine(machine.id);
  }

  const startedMachine = await waitForMachineState(
    machine.id,
    new Set(['started', 'running', 'stopped', 'destroyed']),
    FLY_MACHINE_WAIT_TIMEOUT_MS
  );
  const containerId = await persistUserMachineRef(user.telegram_user_id, startedMachine);
  const status = normalizeMachineState(startedMachine);

  let ready = status === 'running';
  if (ready && config.fly.gatewayProbe) {
    const target = resolveFromMachine(startedMachine.id, startedMachine.private_ip);
    const portReady = await waitForPort(target.host, target.port, config.fly.gatewayProbeTimeoutMs);
    ready = portReady ? await waitForGatewayHello(target.host, target.port, config.fly.gatewayProbeTimeoutMs) : false;
  }

  await updateUser(user.telegram_user_id, {
    container_status: ready ? 'running' : 'error'
  });

  return { containerId, ready };
};

export const ensureUserMachine = async (user: UserRuntimeRef): Promise<{ containerId: string; ready: boolean }> => {
  const key = user.telegram_user_id;
  const existing = ensureUserInFlight.get(key);
  if (existing) return existing;

  const job = runEnsureUserMachine(user).finally(() => {
    if (ensureUserInFlight.get(key) === job) {
      ensureUserInFlight.delete(key);
    }
  });

  ensureUserInFlight.set(key, job);
  return job;
};

const runEnsureAssistantMachine = async (
  assistant: AssistantRuntimeRef
): Promise<{ containerId: string; ready: boolean }> => {
  if (!config.openclaw.apiKey) {
    throw new Error('OPENCLAW_API_KEY is required to start OpenClaw on Fly runtime.');
  }
  const desiredLiteLLMApiKey = resolveAssistantLiteLLMApiKey(assistant);
  await ensureFlyOpenclawImageDigestPullable();

  const fallbackName = resolveAssistantMachineName(assistant);
  let machine = await resolveAssistantMachine(assistant);
  if (machine) {
    const previous = machine;
    machine = await getMachine(machine.id);
    if (!machine.updated_at && previous.updated_at) {
      machine.updated_at = previous.updated_at;
    }
    if (!machine.created_at && previous.created_at) {
      machine.created_at = previous.created_at;
    }

    let latestAppDeployAtMs: number | null = null;
    try {
      latestAppDeployAtMs = await getLatestAppDeployTimestampMs();
    } catch (error: unknown) {
      console.warn('Failed to resolve latest app deployment timestamp', error);
    }

    if (machineNeedsRecreate(machine, latestAppDeployAtMs, assistant.assistant_bot_token, desiredLiteLLMApiKey)) {
      await destroyMachine(machine.id);
      machine = null;
      await updateAssistant(assistant.id, {
        container_status: 'creating',
        container_id: '',
        container_name: fallbackName
      });
    }
  }

  if (!machine) {
    machine = await createAssistantMachine(assistant, desiredLiteLLMApiKey);
  }

  let currentState = normalizeMachineState(machine);
  if (currentState === 'missing') {
    await updateAssistant(assistant.id, {
      container_status: 'creating',
      container_id: '',
      container_name: fallbackName
    });
    machine = await createAssistantMachine(assistant, desiredLiteLLMApiKey);
    currentState = normalizeMachineState(machine);
  }

  if (currentState !== 'running') {
    await startMachine(machine.id);
  }

  const startedMachine = await waitForMachineState(
    machine.id,
    new Set(['started', 'running', 'stopped', 'destroyed']),
    FLY_MACHINE_WAIT_TIMEOUT_MS
  );
  const containerId = await persistAssistantMachineRef(assistant.id, fallbackName, startedMachine);
  const status = normalizeMachineState(startedMachine);

  let ready = status === 'running';
  if (ready && config.fly.gatewayProbe) {
    const target = resolveFromMachine(startedMachine.id, startedMachine.private_ip);
    const portReady = await waitForPort(target.host, target.port, config.fly.gatewayProbeTimeoutMs);
    ready = portReady ? await waitForGatewayHello(target.host, target.port, config.fly.gatewayProbeTimeoutMs) : false;
  }

  await updateAssistant(assistant.id, {
    container_status: ready ? 'running' : 'error',
    container_name: startedMachine.name?.trim() || fallbackName
  });

  return { containerId, ready };
};

export const ensureAssistantMachine = async (
  assistant: AssistantRuntimeRef
): Promise<{ containerId: string; ready: boolean }> => {
  const key = assistant.id;
  const existing = ensureAssistantInFlight.get(key);
  if (existing) return existing;

  const job = runEnsureAssistantMachine(assistant).finally(() => {
    if (ensureAssistantInFlight.get(key) === job) {
      ensureAssistantInFlight.delete(key);
    }
  });

  ensureAssistantInFlight.set(key, job);
  return job;
};

export const restartUserMachine = async (user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>): Promise<void> => {
  const machine = await resolveUserMachine(user);
  if (!machine) throw new Error('Fly machine not found');

  const currentState = normalizeMachineState(machine);
  if (currentState === 'running') {
    await stopMachine(machine.id);
    await waitForMachineState(machine.id, new Set(['stopped', 'created']), 45_000);
  } else if (currentState === 'creating') {
    const settled = await waitForMachineState(machine.id, new Set(['started', 'running', 'stopped']), 45_000);
    if (normalizeMachineState(settled) === 'running') {
      await persistUserMachineRef(user.telegram_user_id, settled);
      await updateUser(user.telegram_user_id, { container_status: 'running' });
      return;
    }
  }

  await startMachine(machine.id);

  const startedMachine = await waitForMachineState(machine.id, new Set(['started', 'running']), FLY_MACHINE_WAIT_TIMEOUT_MS);
  await persistUserMachineRef(user.telegram_user_id, startedMachine);
  await updateUser(user.telegram_user_id, { container_status: 'running' });
};

export const stopUserMachine = async (user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>): Promise<void> => {
  const machine = await resolveUserMachine(user);
  if (!machine) throw new Error('Fly machine not found');
  await stopMachine(machine.id);
  await updateUser(user.telegram_user_id, { container_status: 'stopped' });
};

export const getUserMachineStatus = async (user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>): Promise<string> => {
  const machine = await resolveUserMachine(user);
  if (!machine) return 'missing';

  const status = normalizeMachineState(machine);
  await updateUser(user.telegram_user_id, { container_status: status });
  return status;
};

export const fetchFlyMachineArtifact = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>,
  source: string
): Promise<FlyMachineArtifact | null> => {
  const machineId = extractMachineId(user);
  if (!machineId) return null;

  const candidates = artifactCandidatesForSource(source);
  if (!candidates.length) return null;

  const execArtifactCommand = async (command: string[]): Promise<FlyExecResponse | null> => {
    let delayMs = 200;
    for (let attempt = 1; attempt <= FLY_ARTIFACT_EXEC_RETRIES; attempt += 1) {
      try {
        return await execMachine(machineId, command, FLY_EXEC_TIMEOUT_SECONDS);
      } catch (error: unknown) {
        if (!isRetryableExecError(error) || attempt >= FLY_ARTIFACT_EXEC_RETRIES) {
          return null;
        }
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
    return null;
  };

  const script = buildArtifactResolveScript(candidates);
  const exec = await execArtifactCommand(['sh', '-lc', script]);
  const parseArtifactMeta = (
    stdout: string | undefined
  ): { filePath: string; expectedSize: number } | null => {
    if (typeof stdout !== 'string' || !stdout.trim()) return null;
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const pathLine = lines.find((line) => line.startsWith(FLY_ARTIFACT_HEADER));
    const sizeLine = lines.find((line) => line.startsWith(FLY_ARTIFACT_SIZE_HEADER));
    if (!pathLine || !sizeLine) return null;

    const filePath = pathLine.slice(FLY_ARTIFACT_HEADER.length).trim();
    if (!isAllowedArtifactPath(filePath)) return null;

    const sizeRaw = sizeLine.slice(FLY_ARTIFACT_SIZE_HEADER.length).trim();
    const expectedSize = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(expectedSize) || expectedSize <= 0 || expectedSize > FLY_ARTIFACT_MAX_BYTES) return null;

    return { filePath, expectedSize };
  };

  let meta = exec?.exit_code === 0 ? parseArtifactMeta(exec.stdout) : null;
  if (!meta) {
    const requestedExt = path.posix.extname(stripFileScheme(source).trim()).replace(/^\./, '').toLowerCase();
    if (!requestedExt) return null;
    const directories = Array.from(
      new Set(
        candidates
          .map((candidate) => path.posix.dirname(candidate))
          .filter((dir) => dir && isAllowedArtifactPath(dir))
      )
    );
    if (!directories.length) return null;

    const fallbackScript = buildArtifactResolveByDirectoryScript(directories, requestedExt);
    const fallbackExec = await execArtifactCommand(['sh', '-lc', fallbackScript]);
    if (!fallbackExec || fallbackExec.exit_code !== 0) return null;
    meta = parseArtifactMeta(fallbackExec.stdout);
    if (!meta) return null;
  }

  const { filePath, expectedSize } = meta;

  const chunkCount = Math.ceil(expectedSize / FLY_ARTIFACT_CHUNK_BYTES);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for (let index = 0; index < chunkCount; index += 1) {
    const chunkScript = `dd if=${quoteForShell(filePath)} bs=${FLY_ARTIFACT_CHUNK_BYTES} skip=${index} count=1 2>/dev/null | base64 | tr -d '\\n'`;
    const chunkExec = await execArtifactCommand(['sh', '-lc', chunkScript]);
    if (!chunkExec || chunkExec.exit_code !== 0 || typeof chunkExec.stdout !== 'string') {
      return null;
    }

    const encodedChunk = chunkExec.stdout.replace(/\s+/g, '');
    if (!encodedChunk) {
      return null;
    }

    const chunk = Buffer.from(encodedChunk, 'base64');
    if (!chunk.length) {
      return null;
    }

    chunks.push(chunk);
    totalBytes += chunk.length;
    if (totalBytes > FLY_ARTIFACT_MAX_BYTES) {
      return null;
    }
  }

  if (totalBytes < expectedSize) {
    return null;
  }
  const buffer = Buffer.concat(chunks, totalBytes).subarray(0, expectedSize);

  return {
    buffer,
    filePath,
    fileName: path.posix.basename(filePath) || `artifact-${Date.now()}`
  };
};

const formatEvent = (event: FlyMachineEvent): string => {
  const timestamp =
    typeof event.timestamp === 'number'
      ? new Date(event.timestamp * 1000).toISOString()
      : typeof event.timestamp === 'string'
        ? event.timestamp
        : '';
  const fields = [timestamp, event.source || 'machine', event.type || 'event', event.status || ''].filter(Boolean);
  return fields.join(' ');
};

export const getUserMachineLogs = async (
  user: Pick<UserRecord, 'telegram_user_id' | 'container_id'>,
  tail = 200
): Promise<string> => {
  const machine = await resolveUserMachine(user);
  if (!machine) return '';

  const detail = await getMachine(machine.id);
  const events = Array.isArray(detail.events) ? detail.events.slice(-Math.max(1, tail)) : [];
  if (!events.length) {
    return `machine=${detail.id} state=${detail.state || 'unknown'}`;
  }
  return events.map((event) => formatEvent(event)).join('\n');
};
