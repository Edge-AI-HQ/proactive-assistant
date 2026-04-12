/**
 * Proactive AI Container Orchestrator
 *
 * Uses the unified `users` + `runtime_instances` tables.
 * One user = one container (scope = 'user', no assistant/bot concept).
 */

import type { ContainerRuntime, ContainerRef } from '../container/contracts.js';
import type { ProactiveContainerParams } from './types.js';
import {
  upsertContainer,
  updateContainerStatus,
  getContainerForUser,
  getContainerByInternalId,
  getUserBySupabaseId,
  deleteContainer,
  deleteUserAccount,
  withUserLock,
} from './user_service.js';
import type { ContainerWithToken } from './user_service.js';
import { config } from '../common/config.js';
import { buildAssistantOpenclawConfig } from '../container/providers/shared/openclaw_config.js';
import { ensureProactiveLiteLLMKey } from './litellm_key_service.js';
import { pool } from '../common/db/core.js';

/** Build env vars for a proactive-ai container. */
function buildContainerEnv(params: ProactiveContainerParams): Record<string, string> {
  const litellmApiKey = params.litellmApiKey || process.env.LITELLM_API_KEY || '';

  const openclawConfigContext = {
    openclaw: config.openclaw,
    elevenLabs: config.elevenLabs,
    litellm: config.litellm,
  };

  const openclawConfig = buildAssistantOpenclawConfig(openclawConfigContext, {
    gatewayToken: params.gatewayToken,
    gatewayBind: config.container.runtime === 'docker' ? 'lan' : 'loopback',
    ownerTelegramUserId: null,
    assistantBotToken: null,
    liteLlmApiKey: litellmApiKey || null,
    includeTelegramPlugin: false,
    telegramWebhookMode: false,
  }) as Record<string, unknown>;

  // Merge proactive-ai plugin entries
  const existingPlugins = (openclawConfig.plugins as Record<string, unknown>) ?? {};
  const existingEntries = (existingPlugins.entries as Record<string, unknown>) ?? {};
  openclawConfig.plugins = {
    ...existingPlugins,
    entries: {
      ...existingEntries,
      'proactive-ai-cloud': { enabled: true },
    },
    load: {
      paths: [
        '/opt/pinai/plugins/proactive-ai',
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
    PINAI_GATEWAY_BIND: config.container.runtime === 'docker' ? 'lan' : 'loopback',
  };

  if (config.litellm.enabled && config.litellm.baseUrl) {
    env.LITELLM_BASE_URL = config.litellm.baseUrl;
    if (litellmApiKey) env.LITELLM_API_KEY = litellmApiKey;
  }

  if (process.env.COMPOSIO_API_KEY) env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;
  if (process.env.BROWSERBASE_API_KEY) env.BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
  if (process.env.BROWSERBASE_PROJECT_ID) env.BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

  env.OPENCLAW_PLUGIN_LOAD_PATHS = '/opt/pinai/plugins/proactive-ai';

  return env;
}

const RECONCILE_CACHE_TTL_MS = 30_000;

export class ProactiveContainerOrchestrator {
  private readonly ensureInFlight = new Map<string, Promise<{ containerId: string; ready: boolean }>>();
  private readonly reconcileCache = new Map<string, { result: ContainerWithToken | null; expiresAt: number }>();

  constructor(
    private readonly runtime: ContainerRuntime,
  ) {}

  /**
   * Ensure a user has a running container. Creates if missing, resumes if suspended.
   * @param supabaseUserId - Supabase auth.users UUID
   */
  async ensureContainer(supabaseUserId: string): Promise<{
    containerId: string;
    gatewayToken: string;
    ready: boolean;
  }> {
    const existing = this.ensureInFlight.get(supabaseUserId);
    if (existing) {
      const result = await existing;
      const container = await getContainerForUser(supabaseUserId);
      return { ...result, gatewayToken: container?.gateway_token ?? '' };
    }

    const job = withUserLock(supabaseUserId, () => this.runEnsure(supabaseUserId)).finally(() => {
      if (this.ensureInFlight.get(supabaseUserId) === job) {
        this.ensureInFlight.delete(supabaseUserId);
      }
      this.invalidateReconcileCache(supabaseUserId);
    });
    this.ensureInFlight.set(supabaseUserId, job);

    const result = await job;
    const container = await getContainerForUser(supabaseUserId);
    return { ...result, gatewayToken: container?.gateway_token ?? '' };
  }

  async suspendContainer(supabaseUserId: string): Promise<boolean> {
    const container = await getContainerForUser(supabaseUserId);
    if (!container?.runtime_ref || container.status !== 'running') return false;

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (!ref) return false;

    await this.runtime.suspendContainer(ref.id);
    await updateContainerStatus(container.owner_user_id, { status: 'suspended' });
    this.invalidateReconcileCache(supabaseUserId);
    return true;
  }

  async resumeContainer(supabaseUserId: string): Promise<boolean> {
    const container = await getContainerForUser(supabaseUserId);
    if (!container?.runtime_ref) return false;

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (!ref) return false;

    await this.runtime.startContainer(ref.id);
    await updateContainerStatus(container.owner_user_id, { status: 'running' });
    this.invalidateReconcileCache(supabaseUserId);
    return true;
  }

  async destroyContainer(supabaseUserId: string): Promise<boolean> {
    const container = await getContainerForUser(supabaseUserId);
    if (!container?.runtime_ref) {
      if (container) await deleteContainer(container.owner_user_id);
      this.invalidateReconcileCache(supabaseUserId);
      return false;
    }

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (ref) {
      await this.runtime.destroyContainer(ref.id);
    }
    await deleteContainer(container.owner_user_id);
    this.invalidateReconcileCache(supabaseUserId);
    return true;
  }

  async deleteAccount(supabaseUserId: string): Promise<void> {
    const container = await getContainerForUser(supabaseUserId);

    if (container?.runtime_ref) {
      const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
      if (ref) {
        await this.runtime.destroyContainer(ref.id);
      }
    }

    // Destroy volume (Fly-specific)
    if (container) {
      try {
        const volumeKey = `proactive_${supabaseUserId.replace(/-/g, '').slice(0, 16)}`;
        const { listVolumes, destroyVolume } = await import('../container/providers/fly/fly_client.js');
        const volumes = await listVolumes();
        for (const vol of volumes) {
          if (vol.name === volumeKey && vol.state !== 'pending_destroy') {
            await destroyVolume(vol.id);
          }
        }
      } catch (err) {
        console.error(`[proactive] Failed to destroy volume for user ${supabaseUserId.slice(0, 8)}`, err);
      }
    }

    // Delete LiteLLM key + user
    try {
      const { deleteLiteLLMKey, deleteLiteLLMUser, isLiteLLMClientEnabled } = await import('../litellm/client.js');
      if (isLiteLLMClientEnabled()) {
        const { rows } = await pool.query<{ virtual_key: string; litellm_user_id: string }>(
          `SELECT virtual_key, litellm_user_id FROM proactive_litellm_keys WHERE user_id = $1`,
          [supabaseUserId],
        );
        if (rows[0]) {
          await deleteLiteLLMKey([rows[0].virtual_key]).catch(() => {});
          await deleteLiteLLMUser([rows[0].litellm_user_id]).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[proactive] Failed to clean up LiteLLM for user ${supabaseUserId.slice(0, 8)}`, err);
    }

    await deleteUserAccount(supabaseUserId);
    this.invalidateReconcileCache(supabaseUserId);
    console.log(`[proactive] Account deleted for user ${supabaseUserId.slice(0, 8)}`);
  }

  resolveTarget(container: { runtime_ref: string | null; container_name: string; metadata?: Record<string, unknown> }) {
    if (!container.runtime_ref) return null;
    const ref: ContainerRef = {
      id: container.runtime_ref,
      name: container.container_name,
      state: 'running',
      metadata: (container.metadata ?? {}) as Record<string, string>,
    };
    return this.runtime.resolveGatewayTarget(ref);
  }

  /**
   * Verify DB record against runtime. If DB says running/suspended but the
   * container is gone, delete the stale record and return null.
   * Skips "creating" (transient, managed by runEnsure under advisory lock).
   *
   * Results are cached per-user for 30s to avoid repeated DB+runtime calls
   * during gateway proxy page loads (HTML + JS + CSS + API in quick succession).
   */
  async reconcileContainer(supabaseUserId: string): Promise<ContainerWithToken | null> {
    const cached = this.reconcileCache.get(supabaseUserId);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = await this.reconcileContainerUncached(supabaseUserId);
    this.reconcileCache.set(supabaseUserId, { result, expiresAt: Date.now() + RECONCILE_CACHE_TTL_MS });
    return result;
  }

  /** Invalidate the reconcile cache for a user (call after state-changing operations). */
  invalidateReconcileCache(supabaseUserId: string): void {
    this.reconcileCache.delete(supabaseUserId);
  }

  private async reconcileContainerUncached(supabaseUserId: string): Promise<ContainerWithToken | null> {
    const container = await getContainerForUser(supabaseUserId);
    if (!container) return null;

    // Only reconcile settled states with a runtime ref
    if (!container.runtime_ref || (container.status !== 'running' && container.status !== 'suspended')) {
      return container;
    }

    const ref = await this.runtime.findContainer(container.runtime_ref, [container.container_name]);
    if (ref) return container;

    // Container gone from runtime — stale record
    console.warn(
      `[proactive] Stale record: user=${supabaseUserId.slice(0, 8)}, ` +
      `ref=${container.runtime_ref}, status=${container.status} — cleaning up`
    );
    await deleteContainer(container.owner_user_id);
    return null;
  }

  // ── Private ──

  private async runEnsure(supabaseUserId: string): Promise<{
    containerId: string;
    ready: boolean;
  }> {
    const user = await getUserBySupabaseId(supabaseUserId);
    if (!user) throw new Error(`User not found for supabase_user_id=${supabaseUserId}`);

    const containerName = `proactive-${supabaseUserId.slice(0, 8)}`;

    // Auto-provision LiteLLM virtual key
    let litellmApiKey: string | null = null;
    if (config.litellm.enabled) {
      try {
        litellmApiKey = await ensureProactiveLiteLLMKey(supabaseUserId);
      } catch (err) {
        console.error(`[proactive] Failed to provision LiteLLM key for user ${supabaseUserId.slice(0, 8)}`, err);
      }
    }

    // Check existing container
    let dbContainer = await getContainerByInternalId(user.id);

    if (dbContainer?.runtime_ref) {
      const ref = await this.runtime.findContainer(dbContainer.runtime_ref, [dbContainer.container_name]);

      if (ref) {
        if (ref.state === 'running') {
          // Sync metadata (e.g. hostPort) in case it changed
          await updateContainerStatus(user.id, { status: 'running', runtime_ref: ref.id, metadata: ref.metadata as any });
          return { containerId: ref.id, ready: true };
        }
        if (ref.state === 'suspended' || ref.state === 'stopped') {
          const started = await this.runtime.startContainer(ref.id);
          await updateContainerStatus(user.id, { status: 'running', runtime_ref: started.id, metadata: started.metadata as any });
          return { containerId: started.id, ready: true };
        }
        await this.runtime.destroyContainer(ref.id);
      } else {
        // Stale DB record — container no longer exists in runtime
        console.warn(
          `[proactive] Stale DB record in ensureContainer: user=${supabaseUserId.slice(0, 8)}, ` +
          `ref=${dbContainer.runtime_ref} — deleting before re-create`
        );
        await deleteContainer(user.id);
      }
    }

    // Create new container
    const gatewayToken = user.gateway_token;
    const dbRecord = await upsertContainer({
      internalUserId: user.id,
      containerName,
      runtimeProvider: config.container.runtime,
      status: 'creating',
    });

    const params: ProactiveContainerParams = {
      userId: supabaseUserId,
      internalUserId: user.id,
      containerName,
      gatewayToken,
      litellmApiKey,
    };
    const env = buildContainerEnv(params);

    const created = this.runtime.createGenericContainer
      ? await this.runtime.createGenericContainer({
          containerName,
          gatewayToken,
          env,
          volumeKey: `proactive_${supabaseUserId.replace(/-/g, '').slice(0, 16)}`,
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

    await updateContainerStatus(user.id, {
      status: created.state === 'running' ? 'running' : 'creating',
      runtime_ref: created.id,
      metadata: created.metadata as any,
    });

    if (created.state === 'running') {
      return { containerId: created.id, ready: true };
    }

    try {
      const started = await this.runtime.startContainer(created.id);
      await updateContainerStatus(user.id, { status: 'running', runtime_ref: started.id, metadata: started.metadata as any });
      return { containerId: started.id, ready: true };
    } catch (err) {
      console.error(`[proactive] Failed to start container for user ${supabaseUserId}`, err);
      await updateContainerStatus(user.id, { status: 'error' });
      return { containerId: created.id, ready: false };
    }
  }
}
