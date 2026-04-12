import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayConfigSection,
  buildAssistantOpenclawConfig,
  buildTelegramChannelConfigSection,
} from "./openclaw_config.js";
import type { ContainerManagerConfig } from "../../types.js";

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

const buildContext = (): Pick<
  ContainerManagerConfig,
  "openclaw" | "litellm" | "elevenLabs"
> => ({
  openclaw: {
    image: "registry.fly.io/test@sha256:abc",
    gatewayPort: 18789,
    braveApiKey: "",
  },
  elevenLabs: {
    apiKey: "ELEVEN_SECRET",
    baseUrl: "https://api.elevenlabs.io",
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
// buildGatewayConfigSection
// ---------------------------------------------------------------------------

test("gateway config: loopback bind uses private-network trustedProxies", () => {
  const gw = buildGatewayConfigSection(buildContext(), "tok", "loopback") as {
    trustedProxies: string[];
    bind: string;
  };
  assert.equal(gw.bind, "loopback");
  assert.ok(gw.trustedProxies.includes("127.0.0.0/8"));
  assert.ok(gw.trustedProxies.includes("::1/128"));
  assert.ok(gw.trustedProxies.includes("172.16.0.0/12"));
  // Must NOT include 0.0.0.0/0
  assert.equal(gw.trustedProxies.includes("0.0.0.0/0"), false);
});

test("gateway config: lan bind trusts all sources", () => {
  const gw = buildGatewayConfigSection(buildContext(), "tok", "lan") as {
    trustedProxies: string[];
  };
  assert.deepEqual(gw.trustedProxies, ["0.0.0.0/0"]);
});

test("gateway config: uses token auth mode", () => {
  const gw = buildGatewayConfigSection(buildContext(), "my-token", "loopback") as {
    auth: { mode: string; token: string };
  };
  assert.equal(gw.auth.mode, "token");
  assert.equal(gw.auth.token, "my-token");
});

test("gateway config: throws on empty token", () => {
  assert.throws(
    () => buildGatewayConfigSection(buildContext(), "  ", "loopback"),
    /gateway_token is required/,
  );
});

test("gateway config: controlUi has allowInsecureAuth and origin fallback", () => {
  const gw = buildGatewayConfigSection(buildContext(), "tok", "loopback") as {
    controlUi: {
      allowInsecureAuth: boolean;
      dangerouslyAllowHostHeaderOriginFallback: boolean;
      dangerouslyDisableDeviceAuth?: boolean;
    };
  };
  assert.equal(gw.controlUi.allowInsecureAuth, true);
  assert.equal(gw.controlUi.dangerouslyAllowHostHeaderOriginFallback, true);
  // trusted-proxy mode no longer needs dangerouslyDisableDeviceAuth
  assert.equal(gw.controlUi.dangerouslyDisableDeviceAuth, undefined);
});

test("gateway config: controlOrigin sets allowedOrigins", () => {
  const gw = buildGatewayConfigSection(
    buildContext(),
    "tok",
    "loopback",
    "https://api.example.com",
  ) as { controlUi: { allowedOrigins: string[] } };
  assert.deepEqual(gw.controlUi.allowedOrigins, ["https://api.example.com"]);
});

test("gateway config: enables chatCompletions HTTP endpoint", () => {
  const gw = buildGatewayConfigSection(buildContext(), "tok", "loopback") as {
    http: { endpoints: { chatCompletions: { enabled: boolean } } };
  };
  assert.equal(gw.http.endpoints.chatCompletions.enabled, true);
});

test("gateway config: uses configured gateway port", () => {
  const ctx = buildContext();
  ctx.openclaw.gatewayPort = 9999;
  const gw = buildGatewayConfigSection(ctx, "tok", "loopback") as {
    port: number;
  };
  assert.equal(gw.port, 9999);
});

// ---------------------------------------------------------------------------
// buildAssistantOpenclawConfig — plugin entries & load paths
// ---------------------------------------------------------------------------

test("config: webhook mode enables 3 split plugins with load paths", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: "https://example.com/webhook",
    telegramWebhookPort: 8787,
    pluginLoadPaths: [
      "/opt/pinai/plugins/telegram-api-proxy",
      "/opt/pinai/plugins/platform-hooks",
    ],
    includeTelegramPlugin: true,
  }) as {
    plugins: {
      entries: Record<string, { enabled: boolean }>;
      load?: { paths: string[] };
    };
  };
  assert.equal(result.plugins.entries["telegram-api-proxy"]?.enabled, true);
  assert.equal(result.plugins.entries["platform-hooks"]?.enabled, true);
  assert.equal(result.plugins.entries.telegram?.enabled, true);
  assert.deepEqual(result.plugins.load?.paths, [
    "/opt/pinai/plugins/telegram-api-proxy",
    "/opt/pinai/plugins/platform-hooks",
  ]);
});

test("config: no plugin load paths when pluginLoadPaths is absent", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: "https://example.com/webhook",
    telegramWebhookPort: 8787,
    includeTelegramPlugin: true,
  }) as {
    plugins: {
      entries: Record<string, unknown>;
      load?: { paths: string[] };
    };
  };
  assert.equal(result.plugins.load, undefined);
});

test("config: no plugins section when webhook mode disabled and no telegram plugin", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: false,
    includeTelegramPlugin: false,
  }) as { plugins?: unknown };
  assert.equal(result.plugins, undefined);
});

// ---------------------------------------------------------------------------
// buildAssistantOpenclawConfig — telegram channel
// ---------------------------------------------------------------------------

test("config: webhook mode with assistant token sets private webhook URL", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: "https://example.com/webhook",
    telegramWebhookPath: "/tg-wh",
    telegramWebhookPort: 8787,
    telegramPrivateWebhookPort: 8788,
    includeTelegramPlugin: true,
  }) as { channels: { telegram: { webhookUrl: string; webhookPath: string; webhookPort: number } } };
  // Private webhook URL appends /private
  assert.equal(result.channels.telegram.webhookUrl, "https://example.com/webhook/private");
  assert.equal(result.channels.telegram.webhookPath, "/tg-wh/private");
  assert.equal(result.channels.telegram.webhookPort, 8788);
});

test("config: telegram channel uses partial streaming", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: "https://example.com/webhook",
    telegramWebhookPort: 8787,
    includeTelegramPlugin: true,
  }) as { channels: { telegram: { streaming: string } } };
  assert.equal(result.channels.telegram.streaming, "partial");
});

// ---------------------------------------------------------------------------
// buildAssistantOpenclawConfig — tools, commands, cron, browser
// ---------------------------------------------------------------------------

test("config: enables full tools, all commands, cron, and browser", () => {
  const result = buildAssistantOpenclawConfig(buildContext(), {
    gatewayToken: "tok",
    gatewayBind: "loopback",
    assistantBotToken: "bot-token",
    telegramWebhookMode: true,
    telegramWebhookUrl: "https://example.com/webhook",
    telegramWebhookPort: 8787,
    includeTelegramPlugin: true,
  }) as {
    tools: { profile: string; exec: { security: string } };
    commands: Record<string, unknown>;
    cron: { enabled: boolean };
    browser: { enabled: boolean };
  };
  assert.equal(result.tools.profile, "full");
  assert.equal(result.tools.exec.security, "full");
  assert.equal(result.commands.config, true);
  assert.equal(result.commands.bash, true);
  assert.equal(result.cron.enabled, true);
  assert.equal(result.browser.enabled, false);
});

// ---------------------------------------------------------------------------
// buildTelegramChannelConfigSection
// ---------------------------------------------------------------------------

test("telegram channel: uses assistant bot token and open DM policy", () => {
  const ch = buildTelegramChannelConfigSection("my-bot-token") as {
    botToken: string;
    dmPolicy: string;
    streaming: string;
  };
  assert.equal(ch.botToken, "my-bot-token");
  assert.equal(ch.dmPolicy, "open");
  assert.equal(ch.streaming, "partial");
});

test("telegram channel: includes webhook config when provided", () => {
  const ch = buildTelegramChannelConfigSection("tok", {
    enabled: true,
    url: "https://wh.example.com",
    secret: "sec",
    path: "/wh",
    host: "0.0.0.0",
    port: 8787,
  }) as {
    webhookUrl: string;
    webhookSecret: string;
    webhookPath: string;
    webhookHost: string;
    webhookPort: number;
  };
  assert.equal(ch.webhookUrl, "https://wh.example.com");
  assert.equal(ch.webhookSecret, "sec");
  assert.equal(ch.webhookPath, "/wh");
  assert.equal(ch.webhookHost, "0.0.0.0");
  assert.equal(ch.webhookPort, 8787);
});
