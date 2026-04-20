/**
 * API router — dispatches incoming HTTP requests to handlers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { RouteContext, RouteHandler } from './types.js';
import { json } from './types.js';
import { handleHealth } from './health.js';
import { handleGenerate } from './generate.js';
import { handleRuns } from './runs.js';
import { handleChat } from './chat.js';
import { handleFeedback } from './feedback.js';
import { handleComposio } from './composio.js';
import { handleProfile } from './profile.js';
import { handleSettings } from './settings.js';
import { handleAutoRun } from './auto-run.js';
import { handleDreaming } from './dreaming.js';
import { handleBrowser } from './browser.js';
import { handleMobile } from './mobile.js';
import { handleSkills } from './skills.js';
import { handleCrystallize } from './crystallize.js';

export interface PipelineState {
  running: boolean;
  phase: string | null;
  iteration: number | null;
}

export interface PluginConfig {
  max_iterations: number;
  cards_per_iteration: number;
  agent_timeout_ms: number;
  auto_loop_min_interval_ms: number;
  auto_poll_enabled: boolean;
  auto_ingest_interval_ms: number;
  auto_detect_interval_ms: number;
}

export function createApiHandler(api: OpenClawPluginApi, state: PipelineState, config: PluginConfig) {
  const handlers: RouteHandler[] = [
    handleHealth(state),
    handleGenerate(state, config),
    handleRuns(),
    handleChat(),
    handleFeedback(),
    handleComposio(),
    handleProfile(),
    handleSettings(),
    handleAutoRun(state, config),
    handleDreaming(),
    handleBrowser(),
    handleMobile(),
    handleSkills(),
    handleCrystallize(),
  ];

  return async (req: unknown, res: unknown) => {
    const rq = req as IncomingMessage;
    const r = res as ServerResponse;

    // CORS
    const origin = rq.headers.origin;
    r.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    r.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    r.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (origin) r.setHeader('Access-Control-Allow-Credentials', 'true');
    if (rq.method === 'OPTIONS') { r.writeHead(204); r.end(); return; }

    const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
    const subpath = url.pathname.replace(/^\/proactive-ai\/(?:api|rpc)\/?/, '/');
    const ctx: RouteContext = { api, url, req: rq, res: r, subpath };

    for (const handler of handlers) {
      if (await handler(ctx)) return;
    }
    json(r, 404, { error: 'Not found' });
  };
}
