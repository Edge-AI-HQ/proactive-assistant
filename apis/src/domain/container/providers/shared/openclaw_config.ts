import type {
  ElevenLabsConfig,
  LiteLLMConfig,
  OpenclawConfig,
} from "../../../../types/index.js";
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

export interface OpenclawConfigContext {
  openclaw: OpenclawConfig;
  litellm: LiteLLMConfig;
  elevenLabs: ElevenLabsConfig;
}

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
    dangerouslyDisableDeviceAuth: true,
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

  // Token auth: all callers (OpenClaw internal tools like cron, APIs
  // RPC/probe, browser webchat) authenticate via token in the connect
  // handshake.  This is the only mode compatible with OpenClaw's own
  // internal RPC which doesn't send custom identity headers.
  const auth = {
    mode: "token" as const,
    token: normalizedGatewayToken,
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

export const buildLiteLLMModelsSection = (
  context: OpenclawConfigContext,
  liteLlmApiKey: string,
): { models: UnknownRecord; agents: UnknownRecord } => {
  const models: UnknownRecord = {
    providers: {
      litellm: buildLiteLLMProviderConfig(context.litellm, liteLlmApiKey),
      // Register provider aliases pointing at LiteLLM so that
      // tools.media (audio/image) can resolve API keys without
      // requiring provider-specific env vars in the container.
      openai: {
        baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
        apiKey: liteLlmApiKey,
        models: [],
      },
      anthropic: {
        baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
        apiKey: liteLlmApiKey,
        models: [],
      },
      moonshot: {
        baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
        apiKey: liteLlmApiKey,
        models: [],
      },
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

export interface BuildOpenclawConfigOptions {
  gatewayToken: string;
  gatewayBind: GatewayBindMode;
  liteLlmApiKey?: string | null;
  controlOrigin?: string;
  skillsConfig?: UnknownRecord | null;
}

export const buildOpenclawConfig = (
  context: OpenclawConfigContext,
  options: BuildOpenclawConfigOptions,
): UnknownRecord => {
  const normalizedGatewayToken = options.gatewayToken.trim();
  if (!normalizedGatewayToken) {
    throw new Error(
      "gateway_token is required to start OpenClaw gateway with token auth.",
    );
  }

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
      tts: { auto: "off" },
    },
  };

  if (context.litellm.enabled) {
    const liteLlmSections = buildLiteLLMModelsSection(
      context,
      normalizedLiteLLMApiKey,
    );
    next.models = liteLlmSections.models;
    next.agents = liteLlmSections.agents;
    // Set elevated default to "full" — auto-approve all exec on gateway host
    const agentsDefaults = next.agents as { defaults: UnknownRecord };
    agentsDefaults.defaults.elevatedDefault = "full";
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

  // Custom skills live in /opt/pinai/skills/ — ensure extraDirs is always set
  // so OpenClaw loads them alongside (or instead of) bundled skills.
  const skillsObj = next.skills as UnknownRecord;
  const skillsLoad = (skillsObj.load as UnknownRecord) || {};
  const existingExtraDirs = Array.isArray(skillsLoad.extraDirs)
    ? (skillsLoad.extraDirs as string[])
    : [];
  const PINAI_SKILLS_DIR = "/opt/pinai/skills";
  if (!existingExtraDirs.includes(PINAI_SKILLS_DIR)) {
    skillsObj.load = {
      ...skillsLoad,
      extraDirs: [...existingExtraDirs, PINAI_SKILLS_DIR],
    };
  }

  // Web search provider plugin (v4.5+: provider config moved from
  // tools.web.search.<provider> to plugins.entries.<provider>.config.webSearch)
  const plugins: {
    entries: Record<string, UnknownRecord>;
    load?: { paths: string[] };
  } = {
    entries: {},
  };

  if (context.litellm.enabled && normalizedLiteLLMApiKey) {
    plugins.entries.perplexity = {
      enabled: true,
      config: {
        webSearch: {
          apiKey: normalizedLiteLLMApiKey,
          baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
          model: "sonar-pro",
        },
      },
    };
  }

  // Disable native browser plugin — replaced by Browserbase plugin in proactive-ai
  plugins.entries.browser = { enabled: false };

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
      ask: "off",
      backgroundMs: 10000,
      timeoutSec: 1800,
      notifyOnExit: true,
    },
    web: {
      search: {
        enabled: true,
        maxResults: 10,
        ...(context.litellm.enabled && normalizedLiteLLMApiKey
          ? { provider: "perplexity" }
          : {}),
      },
      fetch: { enabled: true, maxChars: 50000 },
    },
    media: {
      concurrency: 2,
      audio: {
        enabled: true,
        maxBytes: 20971520,
        ...(context.litellm.enabled && normalizedLiteLLMApiKey
          ? {
              models: [
                {
                  provider: "openai",
                  model: "gpt-4o-mini-transcribe",
                  baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
                },
              ],
            }
          : {}),
      },
      image: {
        enabled: true,
        ...(context.litellm.enabled && normalizedLiteLLMApiKey
          ? {
              models: [
                {
                  provider: "moonshot",
                  model: "kimi-k2.6",
                  baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
                },
              ],
            }
          : {}),
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        ...(context.litellm.enabled && normalizedLiteLLMApiKey
          ? {
              models: [
                {
                  provider: "moonshot",
                  model: "kimi-k2.6",
                  baseUrl: context.litellm.baseUrl.replace(/\/+$/, ""),
                },
              ],
            }
          : {}),
      },
    },
    sessions: { visibility: "all" },
    loopDetection: { enabled: false },
  };

  // Enable all commands, including runtime config edits via /config
  next.commands = {
    native: true,
    text: true,
    bash: true,
    config: true,
    debug: true,
    restart: true,
  };

  // Disable built-in agent-browser (replaced by Browserbase plugin)
  next.browser = {
    enabled: false,
  };

  // Enable cron scheduler
  next.cron = {
    enabled: true,
  };

  return next;
};
