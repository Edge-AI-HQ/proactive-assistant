import type { ContainerManagerConfig } from "../../types.js";
import type { GatewayBindMode } from "./openclaw_config.js";
import { deriveAssistantWebhookSecret } from "./telegram_runtime_secret.js";
/**
 * Common webhook-related parameters extracted from ContainerManagerConfig.
 * Both Docker and Fly providers need the same derivation logic.
 */
export interface WebhookParams {
  webhookUrl: string;
  webhookPath: string;
  webhookHost: string;
  webhookPort: number;
  privateWebhookPort: number;
  webhookSecret: string;
  pluginLoadPaths: string[];
}

/**
 * Extract and normalize webhook parameters from the shared config.
 * Docker defaults webhookHost to "0.0.0.0" (LAN bind); Fly uses the
 * configured value as-is (loopback bind behind proxy).
 */
export const buildWebhookParams = (
  config: ContainerManagerConfig,
  assistantBotId: number,
  gatewayToken: string,
  apiAuthToken: string | null | undefined,
  gatewayBind: GatewayBindMode,
): WebhookParams => {
  const { webhookUrl, webhookPath, webhookPort, pluginLoadPaths } =
    config.telegramRouter;
  const webhookHost =
    config.telegramRouter.webhookHost ||
    (gatewayBind === "lan" ? "0.0.0.0" : "");

  return {
    webhookUrl: webhookUrl.trim(),
    webhookPath,
    webhookHost,
    webhookPort,
    privateWebhookPort: webhookPort + 1,
    webhookSecret: deriveAssistantWebhookSecret(
      assistantBotId,
      gatewayToken,
      apiAuthToken,
    ),
    pluginLoadPaths,
  };
};

// Plugin-side knobs the proactive-ai background_tasks scheduler reads from
// process.env at boot. Forwarded from the APIs process so the user container
// honors the same flag/cadence config the operator sets on the APIs Fly app.
// Keep in sync with pinai-openclaw/plugins/proactive-ai/index.ts and the
// "background_tasks scheduler" section of docs/modules/runtime-deployment.mdx.
export const SCHEDULER_PASSTHROUGH_KEYS = [
  "BACKGROUND_AUTO_LOOP_TASKS_ENABLED",
  "BACKGROUND_TASK_TICK_MS",
  "BACKGROUND_TASK_LEASE_MS",
  "CONNECTOR_INIT_DEFAULT_LIMIT",
  "CONNECTOR_INIT_RECONCILER_INTERVAL_MS",
  "CONNECTOR_INIT_EVOLVE_TIMEOUT_MS",
  "CONNECTOR_INIT_DISABLED_TOOLKITS",
  "CONNECTOR_SYNC_INTERVAL_MS",
  "CONNECTOR_SYNC_ENQUEUER_INTERVAL_MS",
  "CONNECTOR_SYNC_DISABLED_TOOLKITS",
  "DREAMING_ENQUEUER_INTERVAL_MS",
] as const;

/**
 * Common container env vars shared by Docker and Fly providers.
 */
export const buildBaseContainerEnv = (
  config: ContainerManagerConfig,
  assistantBotId: number,
  webhookPort: number,
  privateWebhookPort: number,
  telegramRouterUrl: string,
  googleCredentialsFile: string,
  liteLlmApiKey?: string | null,
  gatewayToken?: string | null,
): Record<string, string> => {
  const env: Record<string, string> = {
    OPENCLAW_HOME: "/app",
    OPENCLAW_USER_ID: `assistant-${assistantBotId}`,
    OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
    OPENCLAW_TELEGRAM_WEBHOOK_PORT: String(webhookPort),
    OPENCLAW_TELEGRAM_PRIVATE_WEBHOOK_PORT: String(privateWebhookPort),
    PINAI_OPENCLAW_EXEC_APPROVALS_MODE: "full",
    NODE_COMPILE_CACHE: "/app/cache/node-compile-cache",
    TELEGRAM_ROUTER_URL: telegramRouterUrl,
    GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: googleCredentialsFile,
  };

  // Inject gateway token for plugin auto-pairing
  if (gatewayToken?.trim()) {
    env.OPENCLAW_GATEWAY_TOKEN = gatewayToken.trim();
  }
  if (config.litellm.enabled) {
    const baseUrl = config.litellm.baseUrl?.trim();
    const apiKey = liteLlmApiKey?.trim();
    if (baseUrl) env.LITELLM_BASE_URL = baseUrl;
    if (apiKey) env.LITELLM_API_KEY = apiKey;
  }

  for (const key of SCHEDULER_PASSTHROUGH_KEYS) {
    const value = process.env[key]?.trim();
    if (value) env[key] = value;
  }

  return env;
};
