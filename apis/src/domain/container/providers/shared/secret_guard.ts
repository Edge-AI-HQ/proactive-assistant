import type { ContainerManagerConfig } from "../../types.js";

type SecretScanValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

const normalizeKey = (value: string): string =>
  value.toLowerCase().replace(/[\s_.-]+/g, "");

const FORBIDDEN_SECRET_KEYS = new Set(
  [
    "telegram_bot_token",
    "telegram.token",
    "webhooksecret",
    "telegramwebhooksecret",
    "telegram.webhooksecret",
    "elevenlabs_api_key",
    "xi_api_key",
    "elevenlabs.apikey",
  ].map(normalizeKey),
);

const collectP0SecretValues = (config: ContainerManagerConfig): Set<string> => {
  const values = [
    config.telegram.token,
    config.telegram.webhookSecret,
    config.elevenLabs.apiKey,
  ];
  return new Set(values.map((value) => value.trim()).filter(Boolean));
};

const assertSafeValue = (
  value: unknown,
  path: string,
  secretValues: Set<string>,
): void => {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (!normalized) return;
  if (secretValues.has(normalized)) {
    throw new Error(`[secret-guard] Forbidden secret value detected at ${path}`);
  }
};

const scan = (
  value: SecretScanValue,
  path: string,
  secretValues: Set<string>,
): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry as SecretScanValue, `${path}[${index}]`, secretValues));
    return;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      const keyNorm = normalizeKey(key);
      if (FORBIDDEN_SECRET_KEYS.has(keyNorm)) {
        throw new Error(`[secret-guard] Forbidden secret key detected at ${path}.${key}`);
      }
      scan(entry as SecretScanValue, `${path}.${key}`, secretValues);
    });
    return;
  }

  assertSafeValue(value, path, secretValues);
};

export const assertNoP0SecretsInEnv = (
  env: Record<string, string>,
  config: ContainerManagerConfig,
): void => {
  const secretValues = collectP0SecretValues(config);
  Object.entries(env).forEach(([key, value]) => {
    const keyNorm = normalizeKey(key);
    if (FORBIDDEN_SECRET_KEYS.has(keyNorm)) {
      throw new Error(`[secret-guard] Forbidden env key detected: ${key}`);
    }
    assertSafeValue(value, `env.${key}`, secretValues);
  });
};

export const assertNoP0SecretsInConfig = (
  openclawConfig: Record<string, unknown>,
  config: ContainerManagerConfig,
): void => {
  const secretValues = collectP0SecretValues(config);
  scan(openclawConfig, "openclaw", secretValues);
};
