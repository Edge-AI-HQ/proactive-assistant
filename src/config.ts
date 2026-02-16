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

const ensureLeadingSlash = (value: string): string => (value.startsWith('/') ? value : `/${value}`);

const port = toInt(process.env.PORT, 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const wsPathRaw = process.env.OPENCLAW_WS_PATH;

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
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '',
    baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io',
    sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'
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

export const requiredSecrets: RequiredSecret[] = [
  ['TELEGRAM_BOT_TOKEN', config.telegram.token]
];

export const validateConfig = (): string[] => {
  const missing = requiredSecrets.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length && config.nodeEnv === 'production' && !config.featureFlags.allowMissingSecrets) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
  return missing;
};
