/**
 * Proactive AI Container Orchestrator
 *
 * Simplified from the Telegram-era orchestrator:
 * - One user = one container (no assistant/bot concept)
 * - Gmail-based user ID (UUID from Supabase Auth)
 * - Auto-resume on request if suspended
 */

import crypto from 'node:crypto';
import type { ContainerRuntime, ContainerRef } from '../container/contracts.js';
import type { ProactiveContainerParams } from './types.js';
import {
  upsertContainer,
  updateContainerStatus,
  getContainerForUser,
  deleteContainer,
} from './user_service.js';
import { config } from '../common/config.js';
import { buildAssistantOpenclawConfig } from '../container/providers/shared/openclaw_config.js';
import { ensureProactiveLiteLLMKey } from './litellm_key_service.js';

/**
 * Sign a Supabase-compatible JWT so the container's Supabase client
 * authenticates as this specific user.  RLS policies then enforce
 * `user_id = auth.uid()` automatically.
 */
function signSupabaseUserJwt(userId: string, jwtSecret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + 365 * 86400, // 1 year — container lifetime is much shorter
  };
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', jwtSecret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

/** Build env vars for a proactive-ai container. */
function buildContainerEnv(params: ProactiveContainerParams): Record<string, string> {
  const litellmApiKey = params.litellmApiKey || process.env.LITELLM_API_KEY || '';

  // Build OpenClaw config JSON (gateway, models, tools, etc.)
  const openclawConfigContext = {
    openclaw: config.openclaw,
    elevenLabs: config.elevenLabs,
    litellm: config.litellm,
  };

  const openclawConfig = buildAssistantOpenclawConfig(openclawConfigContext, {
    gatewayToken: params.gatewayToken,
    gatewayBind: 'loopback',
    ownerTelegramUserId: null,
    assistantBotToken: null,
    liteLlmApiKey: litellmApiKey || null,
    includeTelegramPlugin: false,
    telegramWebhookMode: false,
  }) as Record<string, unknown>;

  // Merge proactive-ai plugin entries into whatever buildAssistantOpenclawConfig
  // already set (e.g. perplexity web-search plugin).
  const existingPlugins = (openclawConfig.plugins as Record<string, unknown>) ?? {};
  const existingEntries = (existingPlugins.entries as Record<string, unknown>) ?? {};
  openclawConfig.plugins = {
    ...existingPlugins,
    entries: {
      ...existingEntries,
      'proactive-ai': { enabled: true },
      'litellm-vision-adapter': { enabled: true },
    },
    load: {
      paths: [
        '/opt/pinai/plugins/proactive-ai',
        '/opt/pinai/plugins/litellm-vision-adapter',
      ],
    },
  };

  const configJson = JSON.stringify(openclawConfig);
  const configB64 = Buffer.from(configJson, 'utf8').toString('base64');

  const env: Record<string, string> = {
    OPENCLAW_HOME: '/app',
    OPENCLAW_USER_ID: `proactive-${params.userId.slice(0, 8)}`,
    OPENCLAW_GATEWAY_PORT: String(config.openclaw.gatewayPort),
    OPENCLAW_GATEWAY_TOKEN: params.gatewayToken,
    OPENCLAW_CONFIG_B64: configB64,
    PINAI_OPENCLAW_EXEC_APPROVALS_MODE: 'full',
    NODE_COMPILE_CACHE: '/app/cache/node-compile-cache',
    PROACTIVE_USER_ID: params.userId,
    PINAI_FLY_MODE: '1',
    PINAI_GATEWAY_BIND: 'loopback',
  };

  // Supabase — per-user JWT for RLS-enforced data isolation
  if (process.env.SUPABASE_URL) env.SUPABASE_URL = process.env.SUPABASE_URL;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (jwtSecret) {
    env.SUPABASE_USER_JWT = signSupabaseUserJwt(params.userId, jwtSecret);
  } else if (process.env.SUPABASE_SERVICE_KEY) {
    // Fallback: service key (no RLS isolation — dev only)
    env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  }

  // LiteLLM
  if (config.litellm.enabled && config.litellm.baseUrl) {
    env.LITELLM_BASE_URL = config.litellm.baseUrl;
    if (litellmApiKey) env.LITELLM_API_KEY = litellmApiKey;
  }

  // Composio (platform-level)
  if (process.env.COMPOSIO_API_KEY) env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

  // Browserbase (optional)
  if (process.env.BROWSERBASE_API_KEY) env.BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
  if (process.env.BROWSERBASE_PROJECT_ID) env.BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

  // Plugin load paths — include proactive-ai plugin
  env.OPENCLAW_PLUGIN_LOAD_PATHS = [
    '/opt/pinai/plugins/proactive-ai',
    '/opt/pinai/plugins/litellm-vision-adapter',
  ].join(':');

  return env;
}

export class ProactiveContainerOrchestrator {
  private readonly ensureInFlight = new Map<string, Promise<{ containerId: string; ready: boolean }>>();

  constructor(
    private readonly runtime: ContainerRuntime,
  ) {}

  /**
   * Ensure a user has a running container. Creates if missing, resumes if suspended.
   * LiteLLM virtual key is auto-provisioned per user.
   */
  async ensureContainer(userId: string): Promise<{
    containerId: string;
    gatewayToken: string;
    ready: boolean;
  }> {
    // Dedup concurrent calls for same user
    const existing = this.ensureInFlight.get(userId);
    if (existing) {
      const result = await existing;
      const container = await getContainerForUser(userId);
      return { ...result, gatewayToken: container?.gateway_token ?? '' };
    }

    const job = this.runEnsure(userId).finally(() => {
      if (this.ensureInFlight.get(userId) === job) {
        this.ensureInFlight.delete(userId);
      }
    });
    this.ensureInFlight.set(userId, job);

    const result = await job;
    const container = await getContainerForUser(userId);
    return { ...result, gatewayToken: container?.gateway_token ?? '' };
  }

  /**
   * Suspend a user's container.
   */
  async suspendContainer(userId: string): Promise<boolean> {
    const container = await getContainerForUser(userId);
    if (!container?.runtime_ref) return false;
    if (container.status !== 'running') return false;

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (!ref) return false;

    await this.runtime.suspendContainer(ref.id);
    await updateContainerStatus(userId, { status: 'suspended' });
    return true;
  }

  /**
   * Resume a suspended container.
   */
  async resumeContainer(userId: string): Promise<boolean> {
    const container = await getContainerForUser(userId);
    if (!container?.runtime_ref) return false;

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (!ref) return false;

    await this.runtime.startContainer(ref.id);
    await updateContainerStatus(userId, { status: 'running' });
    return true;
  }

  /**
   * Destroy a user's container.
   */
  async destroyContainer(userId: string): Promise<boolean> {
    const container = await getContainerForUser(userId);
    if (!container?.runtime_ref) {
      await deleteContainer(userId);
      return false;
    }

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (ref) {
      await this.runtime.destroyContainer(ref.id);
    }
    await deleteContainer(userId);
    return true;
  }

  /**
   * Resolve the internal URL for proxying to a user's container.
   */
  resolveTarget(container: { runtime_ref: string | null; container_name: string }) {
    if (!container.runtime_ref) return null;
    const ref: ContainerRef = {
      id: container.runtime_ref,
      name: container.container_name,
      state: 'running',
      metadata: {},
    };
    return this.runtime.resolveGatewayTarget(ref);
  }

  // ── Private ──

  private async runEnsure(userId: string): Promise<{
    containerId: string;
    ready: boolean;
  }> {
    const containerName = `proactive-${userId.slice(0, 8)}`;
    const gatewayToken = crypto.randomUUID();

    // Auto-provision LiteLLM virtual key for this user
    let litellmApiKey: string | null = null;
    if (config.litellm.enabled) {
      try {
        litellmApiKey = await ensureProactiveLiteLLMKey(userId);
      } catch (err) {
        console.error(`[proactive] Failed to provision LiteLLM key for user ${userId.slice(0, 8)}`, err);
      }
    }

    const params: ProactiveContainerParams = {
      userId,
      containerName,
      gatewayToken,
      litellmApiKey,
    };

    // Check if container already exists in DB
    let dbContainer = await getContainerForUser(userId);

    if (dbContainer?.runtime_ref) {
      // Find existing runtime container
      const ref = await this.runtime.findContainer(dbContainer.runtime_ref, [dbContainer.container_name]);

      if (ref) {
        if (ref.state === 'running') {
          return { containerId: ref.id, ready: true };
        }
        if (ref.state === 'suspended' || ref.state === 'stopped') {
          // Resume
          const started = await this.runtime.startContainer(ref.id);
          await updateContainerStatus(userId, { status: 'running', runtime_ref: started.id });
          return { containerId: started.id, ready: true };
        }
        // Other states: destroy and recreate
        await this.runtime.destroyContainer(ref.id);
      }
    }

    // Create new container
    await upsertContainer({
      userId,
      containerName,
      runtimeProvider: config.container.runtime,
      gatewayToken,
      status: 'creating',
    });

    const env = buildContainerEnv(params);

    // Use createGenericContainer (no Telegram assumptions) if available,
    // otherwise fall back to the legacy createContainer.
    const created = this.runtime.createGenericContainer
      ? await this.runtime.createGenericContainer({
          containerName,
          gatewayToken,
          env,
          volumeKey: `proactive_${userId.replace(/-/g, '').slice(0, 16)}`,
        })
      : await this.runtime.createContainer({
          assistantBotId: 0,
          assistantId: 0,
          ownerTelegramUserId: null,
          containerName,
          gatewayToken,
          assistantBotToken: null,
          liteLlmApiKey: params.litellmApiKey,
        } as any);

    await updateContainerStatus(userId, {
      status: created.state === 'running' ? 'running' : 'creating',
      runtime_ref: created.id,
    });

    // Background probe
    if (created.state === 'running') {
      return { containerId: created.id, ready: true };
    }

    // Start if not running
    try {
      const started = await this.runtime.startContainer(created.id);
      await updateContainerStatus(userId, { status: 'running', runtime_ref: started.id });
      return { containerId: started.id, ready: true };
    } catch (err) {
      console.error(`[proactive] Failed to start container for user ${userId}`, err);
      await updateContainerStatus(userId, { status: 'error' });
      return { containerId: created.id, ready: false };
    }
  }
}
