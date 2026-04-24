import assert from "node:assert/strict";
import test from "node:test";
import { buildWebhookParams, buildBaseContainerEnv } from "./webhook_params.js";
import type { ContainerManagerConfig } from "../../types.js";

const buildConfig = (): ContainerManagerConfig => ({
  openclaw: {
    image: "registry.fly.io/test@sha256:abc",
    gatewayPort: 18789,
    braveApiKey: "",
  },
  elevenLabs: {
    apiKey: "",
    baseUrl: "https://api.elevenlabs.io",
  },
  container: {
    runtime: "docker",
    portStart: 20000,
    portEnd: 22000,
    memoryMb: 2048,
    cpuShares: 512,
    idleSuspendMs: 30000,
  },
  fly: {
    apiBaseUrl: "https://api.machines.dev/v1",
    apiToken: "",
    appName: "",
    assistantAppName: "",
    regionFallbacks: [],
    region: "iad",
    volumeSizeGb: 20,
    volumeNamePrefix: "openclaw-user",
    machineCpus: 1,
    gatewayProbe: true,
    gatewayProbeTimeoutMs: 120000,
  },
  telegram: {
    token: "BOT_TOKEN",
    webhookSecret: "WH_SECRET",
    botUsername: "bot",
  },
  telegramRouter: {
    webhookUrl: "https://api.example.com/webhook/telegram",
    webhookPath: "/telegram-webhook",
    webhookHost: "0.0.0.0",
    webhookPort: 8787,
    pluginLoadPaths: [
      "/opt/pinai/plugins/telegram-api-proxy",
      "/opt/pinai/plugins/platform-hooks",
    ],
  },
  litellm: {
    enabled: false,
    baseUrl: "http://127.0.0.1:4000",
    masterKey: "master",
    allowedModels: [],
    openclawDefaultModel: "claude-opus-4-6",
  },
});

// ---------------------------------------------------------------------------
// buildWebhookParams
// ---------------------------------------------------------------------------

test("buildWebhookParams returns correct default values", () => {
  const config = buildConfig();
  const wp = buildWebhookParams(config, 42, "gw-token", "api-token", "loopback");
  assert.equal(wp.webhookUrl, "https://api.example.com/webhook/telegram");
  assert.equal(wp.webhookPath, "/telegram-webhook");
  assert.equal(wp.webhookPort, 8787);
  assert.equal(wp.privateWebhookPort, 8788);
  assert.deepEqual(wp.pluginLoadPaths, [
    "/opt/pinai/plugins/telegram-api-proxy",
    "/opt/pinai/plugins/platform-hooks",
  ]);
});

test("buildWebhookParams derives unique webhook secret via HMAC", () => {
  const config = buildConfig();
  const wp1 = buildWebhookParams(config, 42, "gw-token-a", "api-token", "loopback");
  const wp2 = buildWebhookParams(config, 42, "gw-token-b", "api-token", "loopback");
  // Different gateway tokens produce different secrets
  assert.notEqual(wp1.webhookSecret, wp2.webhookSecret);
  // Same inputs produce same secret (deterministic)
  const wp3 = buildWebhookParams(config, 42, "gw-token-a", "api-token", "loopback");
  assert.equal(wp1.webhookSecret, wp3.webhookSecret);
});

test("buildWebhookParams: LAN bind defaults webhookHost to 0.0.0.0", () => {
  const config = buildConfig();
  config.telegramRouter.webhookHost = "";
  const wp = buildWebhookParams(config, 42, "tok", "api", "lan");
  assert.equal(wp.webhookHost, "0.0.0.0");
});

test("buildWebhookParams: loopback bind with empty host leaves it empty", () => {
  const config = buildConfig();
  config.telegramRouter.webhookHost = "";
  const wp = buildWebhookParams(config, 42, "tok", "api", "loopback");
  assert.equal(wp.webhookHost, "");
});

// ---------------------------------------------------------------------------
// buildBaseContainerEnv
// ---------------------------------------------------------------------------

test("buildBaseContainerEnv sets core env vars", () => {
  const config = buildConfig();
  const env = buildBaseContainerEnv(
    config, 42, 8787, 8788,
    "https://api.example.com",
    "/app/google/credentials.json",
  );
  assert.equal(env.OPENCLAW_HOME, "/app");
  assert.equal(env.OPENCLAW_USER_ID, "assistant-42");
  assert.equal(env.OPENCLAW_GATEWAY_PORT, "18789");
  assert.equal(env.OPENCLAW_TELEGRAM_WEBHOOK_PORT, "8787");
  assert.equal(env.OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT, "8788");
  assert.equal(env.TELEGRAM_ROUTER_URL, "https://api.example.com");
  assert.equal(env.NODE_COMPILE_CACHE, "/app/cache/node-compile-cache");
});

test("buildBaseContainerEnv injects gateway token when provided", () => {
  const config = buildConfig();
  const env = buildBaseContainerEnv(
    config, 42, 8787, 8788,
    "https://api.example.com",
    "/app/google/credentials.json",
    null,
    "my-gw-token",
  );
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "my-gw-token");
});

test("buildBaseContainerEnv omits gateway token when empty", () => {
  const config = buildConfig();
  const env = buildBaseContainerEnv(
    config, 42, 8787, 8788,
    "https://api.example.com",
    "/app/google/credentials.json",
    null,
    "",
  );
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
});

test("buildBaseContainerEnv injects LiteLLM env when enabled", () => {
  const config = buildConfig();
  config.litellm.enabled = true;
  config.litellm.baseUrl = "http://litellm:4000";
  const env = buildBaseContainerEnv(
    config, 42, 8787, 8788,
    "https://api.example.com",
    "/app/google/credentials.json",
    "litellm-key",
  );
  assert.equal(env.LITELLM_BASE_URL, "http://litellm:4000");
  assert.equal(env.LITELLM_API_KEY, "litellm-key");
});

test("buildBaseContainerEnv omits LiteLLM env when disabled", () => {
  const config = buildConfig();
  config.litellm.enabled = false;
  const env = buildBaseContainerEnv(
    config, 42, 8787, 8788,
    "https://api.example.com",
    "/app/google/credentials.json",
  );
  assert.equal(env.LITELLM_BASE_URL, undefined);
  assert.equal(env.LITELLM_API_KEY, undefined);
});

test("buildBaseContainerEnv forwards background_tasks scheduler env from process.env", () => {
  // Set/restore each key around the call so other tests are unaffected.
  const setKeys: Record<string, string> = {
    BACKGROUND_AUTO_LOOP_TASKS_ENABLED: "1",
    BACKGROUND_TASK_TICK_MS: "30000",
    BACKGROUND_TASK_LEASE_MS: "45000",
    CONNECTOR_INIT_DEFAULT_LIMIT: "75",
    CONNECTOR_INIT_RECONCILER_INTERVAL_MS: "300000",
    CONNECTOR_INIT_EVOLVE_TIMEOUT_MS: "20000",
    CONNECTOR_INIT_DISABLED_TOOLKITS: "stripe,discord",
    DREAMING_ENQUEUER_INTERVAL_MS: "120000",
  };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(setKeys)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const env = buildBaseContainerEnv(
      buildConfig(), 42, 8787, 8788,
      "https://api.example.com",
      "/app/google/credentials.json",
    );
    for (const [k, v] of Object.entries(setKeys)) {
      assert.equal(env[k], v, `expected ${k} forwarded`);
    }
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("buildBaseContainerEnv skips scheduler env keys that are unset or empty", () => {
  const keys = [
    "BACKGROUND_AUTO_LOOP_TASKS_ENABLED",
    "BACKGROUND_TASK_TICK_MS",
    "BACKGROUND_TASK_LEASE_MS",
    "CONNECTOR_INIT_DEFAULT_LIMIT",
    "CONNECTOR_INIT_RECONCILER_INTERVAL_MS",
    "CONNECTOR_INIT_EVOLVE_TIMEOUT_MS",
    "CONNECTOR_INIT_DISABLED_TOOLKITS",
    "DREAMING_ENQUEUER_INTERVAL_MS",
  ];
  const previous: Record<string, string | undefined> = {};
  for (const k of keys) {
    previous[k] = process.env[k];
    delete process.env[k];
  }
  // Set one to empty string to confirm we treat blank as "unset".
  process.env.BACKGROUND_TASK_TICK_MS = "   ";
  try {
    const env = buildBaseContainerEnv(
      buildConfig(), 42, 8787, 8788,
      "https://api.example.com",
      "/app/google/credentials.json",
    );
    for (const k of keys) {
      assert.equal(env[k], undefined, `expected ${k} not forwarded`);
    }
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
