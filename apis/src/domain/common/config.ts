import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { Config, RequiredSecret } from '../../types.js';

const findWorkspaceDir = (startDir: string): string => {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string };
        if (packageJson.name === '@pin-ai/apis') return current;
      } catch {
        // ignore malformed package.json and continue searching upward
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(process.cwd());
};

const loadEnvFiles = (): void => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceDir = findWorkspaceDir(moduleDir);
  const repoRoot = path.resolve(workspaceDir, '..');
  const candidates = [
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.local'),
    path.join(workspaceDir, '.env'),
    path.join(workspaceDir, '.env.local')
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({ path: envPath, override: false });
  }
};

loadEnvFiles();

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toBool = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value.trim().toLowerCase());
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

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const port = toInt(process.env.PORT, 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const liteLlmEnabled = toBool(process.env.LITELLM_ENABLED, true);
const liteLlmBaseUrl = stripTrailingSlash(toTrimmed(process.env.LITELLM_BASE_URL, 'http://127.0.0.1:4000'));
const liteLlmContainerBaseUrl = stripTrailingSlash(
  toTrimmed(process.env.LITELLM_CONTAINER_BASE_URL, 'http://host.docker.internal:4000')
);

export const config: Config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port,
  publicBaseUrl,
  apiAuthToken: toTrimmed(process.env.API_INTERNAL_TOKEN),
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || ''
  },
  openclaw: {
    image: process.env.OPENCLAW_IMAGE || 'pinai-openclaw:latest',
    gatewayPort: toInt(process.env.OPENCLAW_GATEWAY_PORT, 18789),
    apiKey: process.env.OPENCLAW_API_KEY || '',
    braveApiKey: process.env.BRAVE_API_KEY || ''
  },
  litellm: {
    enabled: liteLlmEnabled,
    baseUrl: liteLlmBaseUrl,
    containerBaseUrl: liteLlmContainerBaseUrl,
    masterKey: toTrimmed(process.env.LITELLM_MASTER_KEY),
    requestTimeoutMs: toInt(process.env.LITELLM_REQUEST_TIMEOUT_MS, 15000),
    syncIntervalMs: toInt(process.env.LITELLM_SYNC_INTERVAL_MS, 300000),
    keyAliasPrefix: toTrimmed(process.env.LITELLM_KEY_ALIAS_PREFIX, 'claw-assistant-'),
    defaultBudgetUsd: toNullableFloat(process.env.LITELLM_DEFAULT_BUDGET_USD) ?? 0,
    defaultBudgetDuration: toTrimmed(process.env.LITELLM_DEFAULT_BUDGET_DURATION, '30d'),
    defaultRpmLimit: toNullableInt(process.env.LITELLM_DEFAULT_RPM_LIMIT),
    defaultTpmLimit: toNullableInt(process.env.LITELLM_DEFAULT_TPM_LIMIT),
    allowedModels: splitCsv(process.env.LITELLM_ALLOWED_MODELS),
    openclawDefaultModel: toTrimmed(process.env.LITELLM_OPENCLAW_DEFAULT_MODEL, 'claude-opus-4-6')
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '',
    baseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'
  },
  supabase: {
    dbUrl: process.env.SUPABASE_DB_URL || ''
  },
  payment: {
    enabled: toBool(process.env.PAYMENT_ENABLED, false),
    requestTimeoutMs: toInt(process.env.PAYMENT_REQUEST_TIMEOUT_MS, 10000),
    stripeSecretKey: toTrimmed(process.env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: toTrimmed(process.env.STRIPE_WEBHOOK_SECRET),
    stripePriceIdBasic: toTrimmed(process.env.STRIPE_PRICE_ID_BASIC),
    stripePriceIdPro: toTrimmed(process.env.STRIPE_PRICE_ID_PRO),
    stripePriceIdMax: toTrimmed(process.env.STRIPE_PRICE_ID_MAX),
    publicBaseUrl: stripTrailingSlash(toTrimmed(process.env.PAYMENT_PUBLIC_BASE_URL)),
    telegramBotUsername: toTrimmed(process.env.TELEGRAM_BOT_USERNAME),
    cronSecret: toTrimmed(process.env.CRON_SECRET)
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
  const secrets: RequiredSecret[] = [
    ['SUPABASE_DB_URL', config.supabase.dbUrl]
  ];

  if (config.litellm.enabled) {
    secrets.push(['LITELLM_MASTER_KEY', config.litellm.masterKey]);
  }

  if (config.payment.enabled) {
    secrets.push(
      ['STRIPE_SECRET_KEY', config.payment.stripeSecretKey],
      ['STRIPE_PRICE_ID_BASIC', config.payment.stripePriceIdBasic],
      ['STRIPE_PRICE_ID_PRO', config.payment.stripePriceIdPro],
      ['STRIPE_PRICE_ID_MAX', config.payment.stripePriceIdMax],
      ['API_INTERNAL_TOKEN', config.apiAuthToken]
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
