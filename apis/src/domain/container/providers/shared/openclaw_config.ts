import type { ContainerManagerConfig } from "../../types.js";
import {
  buildLiteLLMFallbackModelRefs,
  buildLiteLLMPrimaryModelRef,
  buildLiteLLMProviderConfig,
  type UnknownRecord,
} from "./litellm_models.js";

export type GatewayBindMode = "lan" | "loopback";

type OpenclawConfigContext = Pick<
  ContainerManagerConfig,
  "openclaw" | "litellm" | "elevenLabs"
>;
type TelegramWebhookConfig = {
  enabled?: boolean;
  url?: string;
  secret?: string;
  path?: string;
  host?: string;
  port?: number;
};

export const buildGatewayConfigSection = (
  context: OpenclawConfigContext,
  gatewayToken: string,
  bind: GatewayBindMode,
  controlOrigin?: string,
): UnknownRecord => {
  const controlUi: UnknownRecord = {
    allowInsecureAuth: true,
    // Disable device-identity / pairing checks — our APIs layer already
    // authenticates dashboard sessions before proxying to the gateway.
    dangerouslyDisableDeviceAuth: true,
  };

  // Allow the APIs proxy origin so the Control UI accepts requests forwarded
  // through the /gateway/.../proxy route regardless of bind mode.
  if (controlOrigin) {
    controlUi.allowedOrigins = [controlOrigin];
  }

  // Non-loopback (LAN) binding requires explicit origin policy for Control UI.
  // Docker containers bind to 0.0.0.0 so the host can reach the gateway via
  // port mapping — use the Host-header fallback to avoid enumerating origins.
  if (bind === "lan") {
    controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  }

  // Trust the APIs reverse proxy so the gateway accepts forwarded headers
  // and treats proxied connections as local.
  const trustedProxies =
    bind === "loopback" ? ["127.0.0.0/8"] : ["0.0.0.0/0"];

  return {
    mode: "local",
    port: context.openclaw.gatewayPort,
    bind,
    trustedProxies,
    auth: {
      mode: "token",
      token: gatewayToken,
    },
    controlUi,
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  };
};

export const buildTtsConfigSection = (
  _context: OpenclawConfigContext,
): UnknownRecord => {
  void _context;
  return { auto: "off" };
};

export const buildTalkConfigSection = (
  _context: OpenclawConfigContext,
): UnknownRecord | null => {
  void _context;
  return null;
};

export const buildTelegramChannelConfigSection = (
  assistantBotToken: string,
  webhookConfig?: TelegramWebhookConfig,
): UnknownRecord => {
  const config: UnknownRecord = {
    enabled: webhookConfig?.enabled ?? true,
    dmPolicy: "open",
    botToken: assistantBotToken,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    groups: {
      "*": {
        requireMention: true,
      },
    },
    // LiteLLM + vision providers can emit non-standard streaming chunks
    // (e.g. missing id), which breaks OpenClaw mid-stream handling.
    // Use non-streaming mode to keep Telegram image/file replies stable.
    streaming: "off",
    actions: {
      sendMessage: true,
      deleteMessage: false,
      sticker: true,
    },
  };

  // Webhook 模式配置：保持 provider 启用，由 router 转发 update 到本地 listener
  const webhookUrl = webhookConfig?.url?.trim();
  if (webhookUrl) {
    config.webhookUrl = webhookUrl;
  }
  if (webhookConfig?.secret?.trim()) {
    config.webhookSecret = webhookConfig.secret.trim();
  }
  if (webhookConfig?.path?.trim()) {
    config.webhookPath = webhookConfig.path.trim();
  }
  if (webhookConfig?.host?.trim()) {
    config.webhookHost = webhookConfig.host.trim();
  }
  if (
    typeof webhookConfig?.port === "number" &&
    Number.isFinite(webhookConfig.port)
  ) {
    config.webhookPort = webhookConfig.port;
  }

  return config;
};

export const buildLiteLLMModelsSection = (
  context: OpenclawConfigContext,
  liteLlmApiKey: string,
): { models: UnknownRecord; agents: UnknownRecord } => {
  const models: UnknownRecord = {
    providers: {
      litellm: buildLiteLLMProviderConfig(context.litellm, liteLlmApiKey),
    },
  };

  const nextModel: UnknownRecord = {
    primary: buildLiteLLMPrimaryModelRef(context.litellm),
  };

  const fallbackRefs = buildLiteLLMFallbackModelRefs(context.litellm);
  if (fallbackRefs.length) {
    nextModel.fallbacks = fallbackRefs;
  }

  return {
    models,
    agents: {
      defaults: {
        model: nextModel,
      },
    },
  };
};

interface BuildAssistantOpenclawConfigOptions {
  gatewayToken: string;
  gatewayBind: GatewayBindMode;
  assistantBotToken?: string | null;
  quickStartSyntheticBotToken?: string | null;
  liteLlmApiKey?: string | null;
  includeTelegramPlugin?: boolean;
  telegramWebhookMode?: boolean;
  telegramWebhookUrl?: string;
  telegramWebhookSecret?: string;
  telegramWebhookPath?: string;
  telegramWebhookHost?: string;
  telegramWebhookPort?: number;
  telegramPrivateWebhookPort?: number;
  telegramRouterPluginPath?: string;
  controlOrigin?: string;
}

const normalizeWebhookPath = (value?: string): string => {
  const trimmed = (value || "").trim();
  if (!trimmed) return "/telegram-webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
};

const toPrivateWebhookUrl = (value?: string): string | undefined => {
  const trimmed = (value || "").trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith("/private")
    ? trimmed
    : `${trimmed.replace(/\/+$/, "")}/private`;
};

const withWebhookConfig = (
  base: TelegramWebhookConfig,
  overrides: Partial<TelegramWebhookConfig>,
): TelegramWebhookConfig => ({
  ...base,
  ...overrides,
});

export const buildAssistantOpenclawConfig = (
  context: OpenclawConfigContext,
  options: BuildAssistantOpenclawConfigOptions,
): UnknownRecord => {
  const normalizedGatewayToken = options.gatewayToken.trim();
  if (!normalizedGatewayToken) {
    throw new Error(
      "gateway_token is required to start OpenClaw gateway with token auth.",
    );
  }

  const normalizedAssistantBotToken = (options.assistantBotToken || "").trim();
  const normalizedQuickStartSyntheticBotToken = (
    options.quickStartSyntheticBotToken || ""
  ).trim();
  const normalizedLiteLLMApiKey = (options.liteLlmApiKey || "").trim();
  if (context.litellm.enabled && !normalizedLiteLLMApiKey) {
    throw new Error(
      "LiteLLM is enabled but no API key is available for OpenClaw config model routing.",
    );
  }

  const next: UnknownRecord = {
    gateway: buildGatewayConfigSection(
      context,
      normalizedGatewayToken,
      options.gatewayBind,
      options.controlOrigin?.trim() || undefined,
    ),
    messages: {
      tts: buildTtsConfigSection(context),
    },
  };

  const talk = buildTalkConfigSection(context);
  if (talk) {
    next.talk = talk;
  }

  if (context.litellm.enabled) {
    const liteLlmSections = buildLiteLLMModelsSection(
      context,
      normalizedLiteLLMApiKey,
    );
    next.models = liteLlmSections.models;
    next.agents = liteLlmSections.agents;
  }

  const baseWebhookConfig: TelegramWebhookConfig = { enabled: true };
  if (options.telegramWebhookMode) {
    const normalizedWebhookPath = normalizeWebhookPath(
      options.telegramWebhookPath,
    );
    const normalizedPrivateWebhookPort =
      typeof options.telegramPrivateWebhookPort === "number" &&
      Number.isFinite(options.telegramPrivateWebhookPort)
        ? options.telegramPrivateWebhookPort
        : typeof options.telegramWebhookPort === "number" &&
            Number.isFinite(options.telegramWebhookPort)
          ? options.telegramWebhookPort + 1
          : undefined;

    baseWebhookConfig.path = normalizedWebhookPath;

    if (options.telegramWebhookUrl?.trim()) {
      baseWebhookConfig.url = options.telegramWebhookUrl.trim();
    }
    if (options.telegramWebhookSecret?.trim()) {
      baseWebhookConfig.secret = options.telegramWebhookSecret.trim();
    }
    if (options.telegramWebhookHost?.trim()) {
      baseWebhookConfig.host = options.telegramWebhookHost.trim();
    }
    if (
      typeof options.telegramWebhookPort === "number" &&
      Number.isFinite(options.telegramWebhookPort)
    ) {
      baseWebhookConfig.port = options.telegramWebhookPort;
    }

    // Assistant-scoped token only. Platform-wide Telegram bot credentials
    // must never be injected into user container config.
    if (normalizedAssistantBotToken) {
      const privateWebhookUrl = toPrivateWebhookUrl(baseWebhookConfig.url);
      next.channels = {
        telegram: buildTelegramChannelConfigSection(
          normalizedAssistantBotToken,
          withWebhookConfig(baseWebhookConfig, {
            ...(privateWebhookUrl ? { url: privateWebhookUrl } : {}),
            path: `${normalizedWebhookPath}/private`,
            ...(typeof normalizedPrivateWebhookPort === "number"
              ? { port: normalizedPrivateWebhookPort }
              : {}),
          }),
        ),
      };
    }
  }

  if (!next.channels && normalizedAssistantBotToken) {
    const telegramWebhookConfig: Record<string, unknown> = { enabled: true };
    if (options.telegramWebhookMode) {
      const mapping: [string, unknown][] = [
        ["url", options.telegramWebhookUrl],
        ["secret", options.telegramWebhookSecret],
        ["path", options.telegramWebhookPath],
        ["host", options.telegramWebhookHost],
        ["port", options.telegramWebhookPort],
      ];
      for (const [key, value] of mapping) {
        const present =
          (typeof value === "string" && value.trim() !== "") ||
          typeof value === "number";
        if (present) {
          telegramWebhookConfig[key] = value;
        }
      }
    }

    next.channels = {
      telegram: buildTelegramChannelConfigSection(
        normalizedAssistantBotToken,
        telegramWebhookConfig,
      ),
    };
  } else if (
    !next.channels &&
    options.telegramWebhookMode &&
    normalizedQuickStartSyntheticBotToken
  ) {
    // Quick Start mode (no dedicated assistant token): enable Telegram channel
    // with a non-sensitive synthetic token. Outbound Telegram requests are
    // proxied by telegram-router-proxy and authenticated by APIs.
    next.channels = {
      telegram: buildTelegramChannelConfigSection(
        normalizedQuickStartSyntheticBotToken,
        baseWebhookConfig,
      ),
    };
  }

  // Plugin config is independent of assistantBotToken — OpenClaw's Doctor
  // auto-enables Telegram when it detects TELEGRAM_BOT_TOKEN in env, so the
  // proxy plugin must always be loaded to prevent webhook/command mutations.
  const plugins: {
    entries: Record<string, UnknownRecord>;
    load?: { paths: string[] };
  } = {
    entries: {},
  };

  if (options.includeTelegramPlugin) {
    plugins.entries.telegram = { enabled: true };
  }

  if (options.telegramWebhookMode) {
    plugins.entries["telegram-router-proxy"] = {
      enabled: true,
    };

    const pluginPath = options.telegramRouterPluginPath?.trim();
    if (pluginPath) {
      plugins.load = { paths: [pluginPath] };
    }
  }

  if (Object.keys(plugins.entries).length > 0) {
    next.plugins = plugins;
  }

  return next;
};
