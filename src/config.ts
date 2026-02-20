import 'dotenv/config';
import path from 'node:path';
import type { Config, RequiredSecret } from './types.js';

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const toNullableInt = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return parsed;
};

const toNullableFloat = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
};

const toTrimmed = (value: string | undefined, fallback = ''): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const splitCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);
const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const port = toInt(process.env.PORT, 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const wsPathRaw = process.env.OPENCLAW_WS_PATH;
const liteLlmEnabled = toBool(process.env.LITELLM_ENABLED, false);
const liteLlmBaseUrl = stripTrailingSlash(toTrimmed(process.env.LITELLM_BASE_URL, 'http://127.0.0.1:4000'));
const liteLlmContainerBaseUrl = stripTrailingSlash(
  toTrimmed(process.env.LITELLM_CONTAINER_BASE_URL, 'http://host.docker.internal:4000')
);

export const config: Config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  publicBaseUrl,
  apiDomain: process.env.API_DOMAIN || 'api.pinai.io',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite'),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || ''
  },
  openclaw: {
    image: process.env.OPENCLAW_IMAGE || 'pinai-openclaw:latest',
    gatewayPort: toInt(process.env.OPENCLAW_GATEWAY_PORT, 18789),
    httpPath: ensureLeadingSlash(process.env.OPENCLAW_HTTP_PATH || '/v1/chat/completions'),
    wsPath: wsPathRaw === '/' ? '/' : ensureLeadingSlash(wsPathRaw || '/'),
    apiKey: process.env.OPENCLAW_API_KEY || '',
    braveApiKey: process.env.BRAVE_API_KEY || ''
  },
  litellm: {
    enabled: liteLlmEnabled,
    baseUrl: liteLlmBaseUrl,
    containerBaseUrl: liteLlmContainerBaseUrl,
    masterKey: toTrimmed(process.env.LITELLM_MASTER_KEY),
    keyEncryptionSecret: toTrimmed(process.env.LITELLM_KEY_ENCRYPTION_SECRET),
    requestTimeoutMs: toInt(process.env.LITELLM_REQUEST_TIMEOUT_MS, 15000),
    syncIntervalMs: toInt(process.env.LITELLM_SYNC_INTERVAL_MS, 300000),
    userIdPrefix: toTrimmed(process.env.LITELLM_USER_ID_PREFIX, 'pinai-user-'),
    keyAliasPrefix: toTrimmed(process.env.LITELLM_KEY_ALIAS_PREFIX, 'pinai-assistant-'),
    defaultBudgetUsd: toNullableFloat(process.env.LITELLM_DEFAULT_BUDGET_USD),
    defaultBudgetDuration: toTrimmed(process.env.LITELLM_DEFAULT_BUDGET_DURATION, '30d'),
    defaultRpmLimit: toNullableInt(process.env.LITELLM_DEFAULT_RPM_LIMIT),
    defaultTpmLimit: toNullableInt(process.env.LITELLM_DEFAULT_TPM_LIMIT),
    allowedModels: splitCsv(process.env.LITELLM_ALLOWED_MODELS),
    openclawDefaultModel: toTrimmed(process.env.LITELLM_OPENCLAW_DEFAULT_MODEL, 'claude-opus-4-6'),
    allowProviderFallback: toBool(process.env.LITELLM_ALLOW_PROVIDER_FALLBACK, false)
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '',
    baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io',
    sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || ''
  },
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
    sessionTtlHours: toInt(process.env.ADMIN_SESSION_TTL_HOURS, 12)
  },
  container: {
    runtime: process.env.CONTAINER_RUNTIME === 'fly' ? 'fly' : 'docker',
    portStart: toInt(process.env.CONTAINER_PORT_START, 20000),
    portEnd: toInt(process.env.CONTAINER_PORT_END, 22000),
    memoryMb: toInt(process.env.CONTAINER_MEMORY_MB, 2048),
    cpuShares: toInt(process.env.CONTAINER_CPU_SHARES, 512)
  },
  fly: {
    apiBaseUrl: process.env.FLY_API_BASE_URL || 'https://api.machines.dev/v1',
    apiToken: process.env.FLY_API_TOKEN || '',
    appName: process.env.FLY_APP_NAME || '',
    region: process.env.FLY_REGION || 'iad',
    volumeSizeGb: toInt(process.env.FLY_VOLUME_SIZE_GB, 20),
    volumeNamePrefix: process.env.FLY_VOLUME_NAME_PREFIX || 'openclaw-user',
    machineCpus: toInt(process.env.FLY_MACHINE_CPUS, 1),
    gatewayProbe: toBool(process.env.FLY_GATEWAY_PROBE, true),
    gatewayProbeTimeoutMs: toInt(process.env.FLY_GATEWAY_PROBE_TIMEOUT_MS, 120000)
  },
  featureFlags: {
    allowMissingSecrets: toBool(process.env.ALLOW_MISSING_SECRETS, false)
  }
};

export const requiredSecrets: RequiredSecret[] = (() => {
  const secrets: RequiredSecret[] = [['TELEGRAM_BOT_TOKEN', config.telegram.token]];

  if (config.litellm.enabled) {
    secrets.push(
      ['LITELLM_MASTER_KEY', config.litellm.masterKey],
      ['LITELLM_KEY_ENCRYPTION_SECRET', config.litellm.keyEncryptionSecret]
    );
  }

  return secrets;
})();

export const validateConfig = (): string[] => {
  const missing = requiredSecrets.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length && config.nodeEnv === 'production' && !config.featureFlags.allowMissingSecrets) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  return missing;
};
