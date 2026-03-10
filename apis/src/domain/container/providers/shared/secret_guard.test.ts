import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantOpenclawConfig } from "./openclaw_config.js";
import {
  assertNoP0SecretsInConfig,
  assertNoP0SecretsInEnv,
} from "./secret_guard.js";
import {
  QUICKSTART_SYNTHETIC_BOT_TOKEN,
  deriveAssistantWebhookSecret,
} from "./telegram_runtime_secret.js";
import type { ContainerManagerConfig } from "../../types.js";

const buildConfig = (): ContainerManagerConfig => ({
  openclaw: {
    image: "registry.fly.io/test@sha256:abc",
    gatewayPort: 18789,
    braveApiKey: "",
  },
  elevenLabs: {
    apiKey: "ELEVEN_SECRET",
    baseUrl: "https://api.elevenlabs.io",
  },
  container: {
    runtime: "docker",
    portStart: 20000,
    portEnd: 22000,
    memoryMb: 2048,
    cpuShares: 512,
  },
  fly: {
    apiBaseUrl: "https://api.machines.dev/v1",
    apiToken: "fly-token",
    appName: "pinclaw-api-dev",
    assistantAppName: "pinclaw-assistant-dev",
    regionFallbacks: ["iad"],
    region: "iad",
    volumeSizeGb: 20,
    volumeNamePrefix: "openclaw-user",
    machineCpus: 1,
    gatewayProbe: true,
    gatewayProbeTimeoutMs: 120000,
  },
  telegram: {
    token: "PUBLIC_TELEGRAM_TOKEN",
    webhookSecret: "PUBLIC_WEBHOOK_SECRET",
    botUsername: "bot",
  },
  telegramRouter: {
    webhookUrl: "https://api.example.com/webhook/telegram",
    webhookPath: "/telegram-webhook",
    webhookHost: "0.0.0.0",
    webhookPort: 8787,
    pluginPath: "/opt/pinai/plugins/telegram-router-proxy",
  },
  litellm: {
    enabled: false,
    baseUrl: "http://127.0.0.1:4000",
    masterKey: "master",
    allowedModels: [],
    openclawDefaultModel: "claude-opus-4-6",
  },
});

test("buildAssistantOpenclawConfig does not include platform secrets", () => {
  const context = buildConfig();
  const openclaw = buildAssistantOpenclawConfig(context, {
    gatewayToken: "user-gateway-token",
    gatewayBind: "loopback",
    assistantBotToken: "assistant-bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: context.telegramRouter.webhookUrl,
    telegramWebhookPath: context.telegramRouter.webhookPath,
    telegramWebhookHost: context.telegramRouter.webhookHost,
    telegramWebhookPort: context.telegramRouter.webhookPort,
    includeTelegramPlugin: true,
  });
  const raw = JSON.stringify(openclaw);
  assert.equal(raw.includes(context.telegram.token), false);
  assert.equal(raw.includes(context.telegram.webhookSecret), false);
  assert.equal(raw.includes(context.elevenLabs.apiKey), false);
});

test("quick start builds telegram channel with synthetic token + assistant secret", () => {
  const context = buildConfig();
  const assistantWebhookSecret = deriveAssistantWebhookSecret(
    42,
    "user-gateway-token",
    "api-internal-token",
  );
  const openclaw = buildAssistantOpenclawConfig(context, {
    gatewayToken: "user-gateway-token",
    gatewayBind: "loopback",
    assistantBotToken: null,
    quickStartSyntheticBotToken: QUICKSTART_SYNTHETIC_BOT_TOKEN,
    telegramWebhookMode: true,
    telegramWebhookUrl: context.telegramRouter.webhookUrl,
    telegramWebhookSecret: assistantWebhookSecret,
    telegramWebhookPath: context.telegramRouter.webhookPath,
    telegramWebhookHost: context.telegramRouter.webhookHost,
    telegramWebhookPort: context.telegramRouter.webhookPort,
    includeTelegramPlugin: true,
  });
  const raw = JSON.stringify(openclaw);
  assert.equal(raw.includes(QUICKSTART_SYNTHETIC_BOT_TOKEN), true);
  assert.equal(raw.includes(assistantWebhookSecret), true);
  assert.equal(raw.includes(context.telegram.token), false);
  assert.equal(raw.includes(context.telegram.webhookSecret), false);
});

test("buildAssistantOpenclawConfig enforces full tools defaults for new agents", () => {
  const context = buildConfig();
  const openclaw = buildAssistantOpenclawConfig(context, {
    gatewayToken: "user-gateway-token",
    gatewayBind: "loopback",
    assistantBotToken: "assistant-bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: context.telegramRouter.webhookUrl,
    telegramWebhookPath: context.telegramRouter.webhookPath,
    telegramWebhookHost: context.telegramRouter.webhookHost,
    telegramWebhookPort: context.telegramRouter.webhookPort,
    includeTelegramPlugin: true,
  }) as {
    tools?: { profile?: string };
    agents?: { defaults?: { tools?: { profile?: string } } };
    commands?: { config?: boolean };
    cron?: { enabled?: boolean };
  };

  assert.equal(openclaw.tools?.profile, "full");
  assert.equal(openclaw.agents?.defaults?.tools?.profile, "full");
  assert.equal(openclaw.commands?.config, true);
  assert.equal(openclaw.cron?.enabled, true);
});

test("assertNoP0SecretsInConfig rejects forbidden keys and values", () => {
  const context = buildConfig();
  assert.throws(
    () =>
      assertNoP0SecretsInConfig(
        {
          channels: {
            telegram: {
              botToken: context.telegram.token,
            },
          },
        },
        context,
      ),
    /Forbidden secret value/i,
  );
  assert.doesNotThrow(() =>
    assertNoP0SecretsInConfig(
      {
        channels: {
          telegram: {
            webhookSecret: "assistant-scoped-secret",
          },
        },
      },
      context,
    ),
  );
  assert.throws(
    () =>
      assertNoP0SecretsInConfig(
        {
          channels: {
            telegram: {
              webhookSecret: context.telegram.webhookSecret,
            },
          },
        },
        context,
      ),
    /Forbidden secret value/i,
  );
});

test("assertNoP0SecretsInEnv rejects forbidden keys and values", () => {
  const context = buildConfig();
  assert.throws(
    () =>
      assertNoP0SecretsInEnv(
        {
          TELEGRAM_BOT_TOKEN: "abc",
        },
        context,
      ),
    /Forbidden env key/i,
  );
  assert.throws(
    () =>
      assertNoP0SecretsInEnv(
        {
          SAFE_VAR: context.elevenLabs.apiKey,
        },
        context,
      ),
    /Forbidden secret value/i,
  );
});
