/**
 * OpenClaw Plugin: Proactive AI Cloud
 *
 * Cloud-native proactive-ai engine plugin.
 * Runs inside per-user Fly Machines with local SQLite as the data layer.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { createApiHandler } from './routes/router.js';
import type { PipelineState, PluginConfig } from './routes/router.js';
import { registerBrowserTool } from './browser/tool.js';
import { startAutoLoop, type AutoLoopConfig } from './scheduler/auto-loop.js';
import * as db from './db.js';

const DEFAULT_CONFIG: PluginConfig = {
  max_iterations: 1,
  cards_per_iteration: 8,
  agent_timeout_ms: 300_000,
  auto_loop_min_interval_ms: 900_000,
  auto_poll_enabled: true,
  auto_ingest_interval_ms: 300_000,
  auto_detect_interval_ms: 60_000,
};

async function ensureDefaultProfile(api: OpenClawPluginApi): Promise<void> {
  const existing = await db.getProfile();
  if (existing) return;

  api.logger.info('Seeding default profile');
  await db.upsertProfile({
    displayName: 'User',
    locale: 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    summary: 'A busy professional balancing career, health, finances, and personal growth.',
  });

  const starterGoals = [
    { key: 'career-growth', title: 'Advance career and professional skills', priority: 'high' },
    { key: 'stay-healthy', title: 'Maintain consistent exercise and healthy habits', priority: 'medium' },
    { key: 'financial-plan', title: 'Grow savings and make smart financial decisions', priority: 'medium' },
    { key: 'learn-and-grow', title: 'Dedicate time to learning new skills and ideas', priority: 'medium' },
    { key: 'relationships', title: 'Stay connected with family and close friends', priority: 'medium' },
    { key: 'life-balance', title: 'Protect personal time and avoid burnout', priority: 'high' },
  ];

  for (const g of starterGoals) {
    await db.upsertGoal(g);
  }

  api.logger.info('Default profile seeded with 6 starter goals');
}

let initialized = false;
let profileSeeded = false;
let autoLoopStarted = false;

const plugin = {
  id: 'proactive-ai-cloud',
  name: 'Proactive AI Cloud',
  description: 'Cloud-native proactive AI engine with local SQLite data layer',
  configSchema: {
    type: 'object' as const,
    properties: {
      max_iterations: { type: 'number' as const, default: 1 },
      cards_per_iteration: { type: 'number' as const, default: 8 },
      agent_timeout_ms: { type: 'number' as const, default: 300_000 },
      auto_loop_min_interval_ms: { type: 'number' as const, default: 900_000 },
      auto_poll_enabled: { type: 'boolean' as const, default: true },
      auto_ingest_interval_ms: { type: 'number' as const, default: 300_000 },
      auto_detect_interval_ms: { type: 'number' as const, default: 60_000 },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<PluginConfig>),
    };

    const state: PipelineState = {
      running: false,
      phase: null,
      iteration: null,
    };

    if (!initialized) {
      api.logger.info('Proactive AI Cloud loading');
      initialized = true;
    }

    // Validate required env vars
    const userId = process.env.PROACTIVE_USER_ID;
    if (!userId) {
      api.logger.error('PROACTIVE_USER_ID not set — plugin disabled');
      return;
    }
    // Local SQLite — no external DB required.

    // Seed default profile on first load
    if (!profileSeeded) {
      profileSeeded = true;
      ensureDefaultProfile(api).catch(err => {
        api.logger.warn(`Failed to seed default profile: ${err instanceof Error ? err.message : err}`);
      });
    }

    // Register browser tool (Browserbase) if configured
    if (process.env.BROWSERBASE_API_KEY) {
      registerBrowserTool(api);
    }

    // Register HTTP routes
    const apiHandler = createApiHandler(api, state, config);
    api.registerHttpRoute({ path: '/proactive-ai/api', auth: 'gateway', match: 'prefix', replaceExisting: true, handler: apiHandler });
    api.registerHttpRoute({ path: '/proactive-ai/rpc', auth: 'plugin', match: 'prefix', replaceExisting: true, handler: apiHandler });

    // Start auto-loop scheduler (after profile seed, routes registered)
    if (!autoLoopStarted) {
      autoLoopStarted = true;
      const autoLoopConfig: AutoLoopConfig = {
        auto_poll_enabled: config.auto_poll_enabled,
        auto_ingest_interval_ms: config.auto_ingest_interval_ms,
        auto_detect_interval_ms: config.auto_detect_interval_ms,
        auto_loop_min_interval_ms: config.auto_loop_min_interval_ms,
        max_iterations: config.max_iterations,
        cards_per_iteration: config.cards_per_iteration,
        agent_timeout_ms: config.agent_timeout_ms,
      };
      // Delay scheduler start to give the system time to fully initialize
      setTimeout(() => {
        startAutoLoop(api, autoLoopConfig, state);
      }, 10_000);
    }

    api.logger.info(`Proactive AI Cloud ready (user=${userId.slice(0, 8)}…, routes: /proactive-ai/*)`);
  },
};

export default plugin;
