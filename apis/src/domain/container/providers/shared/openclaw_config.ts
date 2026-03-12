import type { ContainerManagerConfig } from "../../types.js";
import {
  buildLiteLLMFallbackModelRefs,
  buildLiteLLMModelsAllowlist,
  buildLiteLLMPrimaryModelRef,
  buildLiteLLMProviderConfig,
  type UnknownRecord,
} from "./litellm_models.js";
import {
  DEFAULT_PREINSTALLED_BUNDLED_SKILLS,
  ensureBundledSkillsInstalled,
} from "../../../skills/openclaw_skills.js";

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

const buildOwnerAllowFrom = (
  ownerTelegramUserId?: string | null,
): string[] | undefined => {
  const normalized = (ownerTelegramUserId || "").trim();
  if (!normalized) return undefined;
  const values = new Set<string>([normalized]);
  if (/^\d+$/.test(normalized)) {
    values.add(`tg:${normalized}`);
  }
  return Array.from(values);
};

/** Header used by trusted-proxy auth to carry the operator identity. */
export const TRUSTED_PROXY_USER_HEADER = "x-pinai-identity";

export const buildGatewayConfigSection = (
  context: OpenclawConfigContext,
  gatewayToken: string,
  bind: GatewayBindMode,
  controlOrigin?: string,
): UnknownRecord => {
  const normalizedGatewayToken = gatewayToken.trim();
  if (!normalizedGatewayToken) {
    throw new Error(
      "gateway_token is required for OpenClaw gateway auth.",
    );
  }

  const controlUi: UnknownRecord = {
    allowInsecureAuth: true,
  };

  // Allow the APIs proxy origin so the Control UI accepts requests forwarded
  // through the /gateway/.../proxy route regardless of bind mode.
  if (controlOrigin) {
    controlUi.allowedOrigins = [controlOrigin];
  }

  // Allow the gateway to accept connections whose Origin matches the Host
  // header.  This is needed in ALL bind modes because our APIs layer proxies
  // browser connections to the gateway — the browser's Origin (e.g. an ngrok
  // or Fly public URL) won't match 127.0.0.1, but it DOES match the Host
  // header the browser sends.
  controlUi.dangerouslyAllowHostHeaderOriginFallback = true;

  // Trust the APIs reverse proxy so the gateway accepts forwarded headers
  // and treats proxied connections as local.
  const trustedProxies =
    bind === "loopback"
      ? [
          "127.0.0.0/8",
          "::1/128",
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "fc00::/7",
        ]
      : ["0.0.0.0/0"];

  // Token auth mode: the gateway validates the token on the `connect`
  // handshake.  Trusted-proxy config is kept so it can be enabled later
  // once all intermediate proxies (ngrok, APIs reverse proxy) are
  // guaranteed to forward custom headers.
  const auth = {
    mode: "token" as const,
    token: normalizedGatewayToken,
    trustedProxy: {
      userHeader: TRUSTED_PROXY_USER_HEADER,
    },
  };

  return {
    mode: "local",
    port: context.openclaw.gatewayPort,
    bind,
    trustedProxies,
    auth,
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
    // Use "partial" streaming so OpenClaw sends incremental drafts via
    // sendMessageDraft (Bot API 9.3+) while generating, then finalises
    // with sendMessage.  Vision requests are still forced non-stream by
    // the telegram-router-proxy LiteLLM adapter to avoid broken chunks.
    streaming: "partial",
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
        models: buildLiteLLMModelsAllowlist(context.litellm),
      },
    },
  };
};

interface BuildAssistantOpenclawConfigOptions {
  gatewayToken: string;
  gatewayBind: GatewayBindMode;
  ownerTelegramUserId?: string | null;
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
  pluginLoadPaths?: string[];
  controlOrigin?: string;
  skillsConfig?: UnknownRecord | null;
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

  if (options.skillsConfig && Object.keys(options.skillsConfig).length > 0) {
    next.skills = options.skillsConfig;
  } else {
    // No runtime skills metadata — install default bundled skills
    const defaultSkills = ensureBundledSkillsInstalled(
      null,
      DEFAULT_PREINSTALLED_BUNDLED_SKILLS,
    );
    next.skills = defaultSkills as UnknownRecord;
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

  // Plugin config — three independent plugins replace the old monolithic
  // telegram-router-proxy.  Each handles a single concern:
  //   telegram-api-proxy:     Telegram API URL rewrite + method blocking
  //   litellm-vision-adapter: Vision streaming adaptation
  //   platform-hooks:         Cron delivery + device auto-pairing
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
    plugins.entries["telegram-api-proxy"] = { enabled: true };
    plugins.entries["litellm-vision-adapter"] = { enabled: true };
    plugins.entries["platform-hooks"] = { enabled: true };

    const paths = options.pluginLoadPaths?.filter((p) => p.trim());
    if (paths?.length) {
      plugins.load = { paths };
    }
  }

  if (Object.keys(plugins.entries).length > 0) {
    next.plugins = plugins;
  }

  // Enable all tools with full profile
  next.tools = {
    profile: "full",
    allow: ["*"],
    deny: [],
    elevated: { enabled: true, allowFrom: { "*": ["*"] } },
    exec: {
      security: "full",
      host: "gateway",
      backgroundMs: 10000,
      timeoutSec: 1800,
      notifyOnExit: true,
    },
    web: {
      search: {
        enabled: true,
        maxResults: 10,
        ...(context.litellm.enabled && normalizedLiteLLMApiKey
          ? {
              provider: "perplexity",
              perplexity: {
                apiKey: normalizedLiteLLMApiKey,
                baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
                model: "sonar-pro",
              },
            }
          : {}),
      },
      fetch: { enabled: true, maxChars: 50000 },
    },
    media: {
      concurrency: 2,
      audio: { enabled: true, maxBytes: 20971520 },
      video: { enabled: true, maxBytes: 52428800 },
    },
    sessions: { visibility: "all" },
    loopDetection: { enabled: false },
  };

  // Enable all commands, including runtime config edits via /config
  const commands: UnknownRecord = {
    native: true,
    text: true,
    bash: true,
    config: true,
    debug: true,
    restart: true,
  };
  const ownerAllowFrom = buildOwnerAllowFrom(options.ownerTelegramUserId);
  if (ownerAllowFrom?.length) {
    commands.ownerAllowFrom = ownerAllowFrom;
  }
  next.commands = commands;

  // Enable browser capability
  next.browser = {
    enabled: true,
    evaluateEnabled: true,
  };

  // Enable cron scheduler
  next.cron = {
    enabled: true,
  };

  return next;
};
