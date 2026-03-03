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
): UnknownRecord => ({
  mode: "local",
  port: context.openclaw.gatewayPort,
  bind,
  auth: {
    mode: "token",
    token: gatewayToken,
  },
  controlUi: {
    allowInsecureAuth: true,
  },
  http: {
    endpoints: {
      chatCompletions: { enabled: true },
    },
  },
});

export const buildTtsConfigSection = (
  context: OpenclawConfigContext,
): UnknownRecord => {
  const base: UnknownRecord = {
    auto: "off",
    provider: "elevenlabs",
  };

  const apiKey = context.elevenLabs.apiKey.trim();
  if (!apiKey) return base;

  const elevenlabs: UnknownRecord = { apiKey };
  const baseUrl = context.elevenLabs.baseUrl.trim();
  if (baseUrl) {
    elevenlabs.baseUrl = baseUrl;
  }
  base.elevenlabs = elevenlabs;
  return base;
};

export const buildTalkConfigSection = (
  context: OpenclawConfigContext,
): UnknownRecord | null => {
  const apiKey = context.elevenLabs.apiKey.trim();
  if (!apiKey) return null;
  return { apiKey };
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
    streamMode: "partial",
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
  publicBotToken?: string | null;
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
  const normalizedPublicBotToken = (options.publicBotToken || "").trim();
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

    if (normalizedPublicBotToken && normalizedAssistantBotToken) {
      const accounts: Record<string, UnknownRecord> = {};
      accounts.default = buildTelegramChannelConfigSection(
        normalizedPublicBotToken,
        baseWebhookConfig,
      );
      const privateWebhookUrl = toPrivateWebhookUrl(baseWebhookConfig.url);
      accounts.private = buildTelegramChannelConfigSection(
        normalizedAssistantBotToken,
        withWebhookConfig(baseWebhookConfig, {
          ...(privateWebhookUrl ? { url: privateWebhookUrl } : {}),
          path: `${normalizedWebhookPath}/private`,
          ...(typeof normalizedPrivateWebhookPort === "number"
            ? { port: normalizedPrivateWebhookPort }
            : {}),
        }),
      );

      next.channels = {
        telegram: {
          enabled: true,
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "allowlist",
          accounts,
        },
      };
      next.session = {
        dmScope: "per-account-channel-peer",
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
  } else if (!next.channels && options.telegramWebhookMode) {
    // Quick Start mode: no dedicated bot token, but OpenClaw Doctor will
    // auto-enable Telegram via TELEGRAM_BOT_TOKEN env. We still need to
    // inject webhook params so it listens on the webhook port instead of
    // falling back to polling (getUpdates).
    const telegramChannel: UnknownRecord = {
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
    };
    const webhookMapping: [string, string, unknown][] = [
      ["webhookUrl", "url", options.telegramWebhookUrl],
      ["webhookSecret", "secret", options.telegramWebhookSecret],
      ["webhookPath", "path", options.telegramWebhookPath],
      ["webhookHost", "host", options.telegramWebhookHost],
      ["webhookPort", "port", options.telegramWebhookPort],
    ];
    for (const [configKey, _label, value] of webhookMapping) {
      const present =
        (typeof value === "string" && value.trim() !== "") ||
        typeof value === "number";
      if (present) {
        telegramChannel[configKey] = value;
      }
    }
    next.channels = { telegram: telegramChannel };
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
