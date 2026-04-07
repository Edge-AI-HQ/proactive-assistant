/**
 * OpenClaw Plugin: Proactive AI (v2)
 *
 * Registers:
 * 1. Skills (via openclaw.plugin.json) — pin-cli command reference for agents
 * 2. `/generate` command — manually trigger intent card generation
 * 3. HTTP routes on OpenClaw gateway — UI + API (no separate server)
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { DEFAULT_CONFIG, type ProactiveAIConfig } from './src/config.js';
import { shared } from './src/state.js';
import { ensureDefaultProfile } from './src/profile-seed.js';
import { runPipeline } from './src/pipeline/orchestrator.js';
import { createUiHandler } from './src/server/ui-route.js';
import { createAssetsHandler } from './src/server/assets-route.js';
import { createApiHandler } from './src/server/api-router.js';

const pluginDir = dirname(fileURLToPath(import.meta.url));

export default {
  id: 'proactive-ai',
  configSchema: {
    type: 'object' as const,
    properties: {
      max_iterations: { type: 'number' as const, default: 3 },
      agent_timeout_ms: { type: 'number' as const, default: 300_000 },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: ProactiveAIConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<ProactiveAIConfig>),
    };

    if (!shared.initialized) {
      api.logger.info('Proactive AI v2 loading');
      shared.initialized = true;
    } else {
      api.logger.debug('Proactive AI v2 reload (runtime plugin re-resolve)');
    }

    if (!shared.profileSeeded) {
      shared.profileSeeded = true;
      ensureDefaultProfile(api).catch(err => {
        api.logger.warn(`Failed to seed default profile: ${err instanceof Error ? err.message : err}`);
      });
    }

    // ── /generate command ──

    api.registerCommand({
      name: 'generate',
      description: 'Trigger intent card generation pipeline',
      async handler() {
        api.logger.info('Manual intent card generation triggered');
        try {
          const result = await runPipeline(api, {
            maxIterations: config.max_iterations,
            agentTimeoutMs: config.agent_timeout_ms,
          });
          return `Generated ${result.finalCards.length} intent cards in ${result.totalIterations} iterations.\n\n${JSON.stringify(result.finalCards, null, 2)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Pipeline failed: ${msg}`;
        }
      },
    });

    // ── HTTP routes ──

    const gwAuth = (api.config as Record<string, unknown>)?.['gateway'] as Record<string, unknown> | undefined;
    const gwToken = ((gwAuth?.['auth'] as Record<string, unknown>)?.['token'] as string) ?? '';

    api.registerHttpRoute({ path: '/proactive-ai',        auth: 'plugin',  match: 'exact',  replaceExisting: true, handler: createUiHandler(pluginDir, gwToken) });
    api.registerHttpRoute({ path: '/proactive-ai/assets', auth: 'plugin',  match: 'prefix', replaceExisting: true, handler: createAssetsHandler(pluginDir) });
    api.registerHttpRoute({ path: '/proactive-ai/api',    auth: 'gateway', match: 'prefix', replaceExisting: true, handler: createApiHandler(api) });

    api.logger.info('Proactive AI v2 ready (routes: /proactive-ai/*)');
  },
};
