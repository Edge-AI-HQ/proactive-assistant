import type { ContainerManagerConfig } from '../../types.js';
import {
  buildLiteLLMFallbackModelRefs,
  buildLiteLLMPrimaryModelRef,
  buildLiteLLMProviderConfig,
  type UnknownRecord
} from './litellm_models.js';

export type GatewayBindMode = 'lan' | 'loopback';

type OpenclawConfigContext = Pick<ContainerManagerConfig, 'openclaw' | 'litellm' | 'elevenLabs'>;

export const buildGatewayConfigSection = (
  context: OpenclawConfigContext,
  gatewayToken: string,
  bind: GatewayBindMode
): UnknownRecord => ({
  mode: 'local',
  port: context.openclaw.gatewayPort,
  bind,
  auth: {
    mode: 'token',
    token: gatewayToken
  },
  controlUi: {
    allowInsecureAuth: true
  },
  http: {
    endpoints: {
      chatCompletions: { enabled: true }
    }
  }
});

export const buildTtsConfigSection = (context: OpenclawConfigContext): UnknownRecord => {
  const base: UnknownRecord = {
    auto: 'off',
    provider: 'elevenlabs'
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

export const buildTalkConfigSection = (context: OpenclawConfigContext): UnknownRecord | null => {
  const apiKey = context.elevenLabs.apiKey.trim();
  if (!apiKey) return null;
  return { apiKey };
};

export const buildTelegramChannelConfigSection = (
  assistantBotToken: string,
  webhookConfig?: {
    enabled?: boolean;
    url?: string;
    secret?: string;
    path?: string;
    host?: string;
    port?: number;
  }
): UnknownRecord => {
  const config: UnknownRecord = {
    enabled: webhookConfig?.enabled ?? true,
    dmPolicy: 'open',
    botToken: assistantBotToken,
    allowFrom: ['*'],
    groupAllowFrom: [],
    groupPolicy: 'open',
    groups: {
      '*': {
        requireMention: true
      }
    },
    streamMode: 'partial',
    actions: {
      sendMessage: true,
      deleteMessage: false,
      sticker: true
    }
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
  if (typeof webhookConfig?.port === 'number' && Number.isFinite(webhookConfig.port)) {
    config.webhookPort = webhookConfig.port;
  }

  return config;
};

export const buildLiteLLMModelsSection = (
  context: OpenclawConfigContext,
  liteLlmApiKey: string
): { models: UnknownRecord; agents: UnknownRecord } => {
  const models: UnknownRecord = {
    providers: {
      litellm: buildLiteLLMProviderConfig(context.litellm, liteLlmApiKey)
    }
  };

  const nextModel: UnknownRecord = {
    primary: buildLiteLLMPrimaryModelRef(context.litellm)
  };

  const fallbackRefs = buildLiteLLMFallbackModelRefs(context.litellm);
  if (fallbackRefs.length) {
    nextModel.fallbacks = fallbackRefs;
  }

  return {
    models,
    agents: {
      defaults: {
        model: nextModel
      }
    }
  };
};

interface BuildAssistantOpenclawConfigOptions {
  gatewayToken: string;
  gatewayBind: GatewayBindMode;
  assistantBotToken?: string | null;
  liteLlmApiKey?: string | null;
  includeTelegramPlugin?: boolean;
  telegramWebhookMode?: boolean;
  telegramWebhookUrl?: string;
  telegramWebhookSecret?: string;
  telegramWebhookPath?: string;
  telegramWebhookHost?: string;
  telegramWebhookPort?: number;
  telegramRouterPluginPath?: string;
}

export const buildAssistantOpenclawConfig = (
  context: OpenclawConfigContext,
  options: BuildAssistantOpenclawConfigOptions
): UnknownRecord => {
  const normalizedGatewayToken = options.gatewayToken.trim();
  if (!normalizedGatewayToken) {
    throw new Error('gateway_token is required to start OpenClaw gateway with token auth.');
  }

  const normalizedAssistantBotToken = (options.assistantBotToken || '').trim();
  const normalizedLiteLLMApiKey = (options.liteLlmApiKey || '').trim();
  if (context.litellm.enabled && !normalizedLiteLLMApiKey) {
    throw new Error('LiteLLM is enabled but no API key is available for OpenClaw config model routing.');
  }

  const next: UnknownRecord = {
    gateway: buildGatewayConfigSection(context, normalizedGatewayToken, options.gatewayBind),
    messages: {
      tts: buildTtsConfigSection(context)
    }
  };

  const talk = buildTalkConfigSection(context);
  if (talk) {
    next.talk = talk;
  }

  if (context.litellm.enabled) {
    const liteLlmSections = buildLiteLLMModelsSection(context, normalizedLiteLLMApiKey);
    next.models = liteLlmSections.models;
    next.agents = liteLlmSections.agents;
  }

  if (normalizedAssistantBotToken) {
    const telegramWebhookConfig = {
      enabled: true,
      ...(options.telegramWebhookMode && options.telegramWebhookUrl
        ? { url: options.telegramWebhookUrl }
        : {}),
      ...(options.telegramWebhookMode && options.telegramWebhookSecret
        ? { secret: options.telegramWebhookSecret }
        : {}),
      ...(options.telegramWebhookMode && options.telegramWebhookPath
        ? { path: options.telegramWebhookPath }
        : {}),
      ...(options.telegramWebhookMode && options.telegramWebhookHost
        ? { host: options.telegramWebhookHost }
        : {}),
      ...(options.telegramWebhookMode && typeof options.telegramWebhookPort === 'number'
        ? { port: options.telegramWebhookPort }
        : {})
    };

    next.channels = {
      telegram: buildTelegramChannelConfigSection(
        normalizedAssistantBotToken,
        telegramWebhookConfig
      )
    };

    // 配置 plugins
    const plugins: {
      entries: Record<string, UnknownRecord>;
      load?: { paths: string[] };
    } = {
      entries: {}
    };

    if (options.includeTelegramPlugin) {
      plugins.entries.telegram = { enabled: true };
    }

    // 如果启用 webhook 模式，加载路由代理 plugin
    if (options.telegramWebhookMode) {
      plugins.entries['telegram-router-proxy'] = {
        enabled: true
      };

      const pluginPath = options.telegramRouterPluginPath?.trim();
      if (pluginPath) {
        plugins.load = { paths: [pluginPath] };
      }
    }

    next.plugins = plugins;
  }

  return next;
};
