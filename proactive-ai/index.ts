/**
 * OpenClaw Plugin: Proactive AI (v2)
 *
 * Registers:
 * 1. Skills (via openclaw.plugin.json) — pin-cli command reference for agents
 * 2. `/generate` command — manually trigger intent card generation
 * 3. HTTP routes on OpenClaw gateway — UI + API (no separate server)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { pinCli } from './src/pipeline/pin-cli.js';
import { runPipeline, DEFAULT_PIPELINE_OPTIONS } from './src/pipeline/orchestrator.js';
import type { ServerEvent } from './src/types/index.js';

// ── Plugin Config ──

interface ProactiveAIConfig {
  max_iterations: number;
  agent_timeout_ms: number;
}

const DEFAULT_CONFIG: ProactiveAIConfig = {
  max_iterations: 2,
  agent_timeout_ms: 300_000,
};

// ── Load UI HTML at module init ──

const thisDir = dirname(fileURLToPath(import.meta.url));
const UI_HTML = readFileSync(resolve(thisDir, 'src', 'ui', 'index.html'), 'utf-8');

// ── Plugin Entry ──

let pipelineRunning = false;

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

    api.logger.info('Proactive AI v2 loading');

    // ── 0. Ensure default profile exists ──

    ensureDefaultProfile(api).catch(err => {
      api.logger.warn(`Failed to seed default profile: ${err instanceof Error ? err.message : err}`);
    });

    // ── 1. Register /generate command (chat interface) ──

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

    // ── 3. Register HTTP routes on OpenClaw gateway ──

    const gwAuth = (api.config as Record<string, unknown>)?.['gateway'] as Record<string, unknown> | undefined;
    const gwAuthInner = gwAuth?.['auth'] as Record<string, unknown> | undefined;
    const gwToken = (gwAuthInner?.['token'] as string) ?? '';

    api.registerHttpRoute({
      path: '/proactive-ai',
      auth: 'plugin',
      match: 'exact',
      async handler(_req, res) {
        const r = res as import('node:http').ServerResponse;
        const html = UI_HTML.replace(
          '<!-- __GW_TOKEN__ -->',
          `<script>window.__GW_TOKEN__=${JSON.stringify(gwToken)};</script>`,
        );
        r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        r.end(html);
      },
    });

    api.registerHttpRoute({
      path: '/proactive-ai/api',
      auth: 'gateway',
      match: 'prefix',
      async handler(req, res) {
        const r = res as import('node:http').ServerResponse;
        const rq = req as import('node:http').IncomingMessage;
        const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
        const subpath = url.pathname.replace(/^\/proactive-ai\/api\/?/, '/');

        const json = (status: number, data: unknown) => {
          r.writeHead(status, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify(data));
        };

        const readBody = (): Promise<Record<string, unknown>> =>
          new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            rq.on('data', (c: Buffer) => chunks.push(c));
            rq.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve({}); }
            });
            rq.on('error', reject);
          });

        // GET /api/health
        if (subpath === '/health' && rq.method === 'GET') {
          json(200, { ok: true, pipelineRunning });
          return;
        }

        // GET /api/generate → SSE pipeline stream
        if (subpath === '/generate' && rq.method === 'GET') {
          if (pipelineRunning) {
            json(409, { error: 'Pipeline is already running' });
            return;
          }

          r.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          const sendEvent = (event: ServerEvent) => {
            r.write(`data: ${JSON.stringify(event)}\n\n`);
          };

          pipelineRunning = true;

          try {
            const maxIter = parseInt(url.searchParams.get('iterations') ?? '', 10)
              || DEFAULT_PIPELINE_OPTIONS.maxIterations;

            await runPipeline(
              api,
              { ...DEFAULT_PIPELINE_OPTIONS, maxIterations: maxIter },
              sendEvent,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            api.logger.error(`Pipeline error: ${message}`);
            sendEvent({ type: 'pipeline:error', data: { message } });
          } finally {
            pipelineRunning = false;
            r.end();
          }
          return;
        }

        // ── Composio routes (all delegated to pin-cli) ──

        // GET /api/composio/status — check if key is configured
        if (subpath === '/composio/status' && rq.method === 'GET') {
          try {
            const result = await pinCli('personal status');
            json(200, result.ok ? result.data : { configured: false });
          } catch {
            json(200, { configured: false });
          }
          return;
        }

        // POST /api/composio/setup — save consumer key
        if (subpath === '/composio/setup' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const key = String(body['key'] ?? '').trim();
            if (!key) {
              json(400, { error: 'Missing key' });
              return;
            }
            const result = await pinCli(`personal setup --key ${key}`);
            if (result.ok) {
              json(200, result.data);
            } else {
              json(400, { error: result.error ?? 'Setup failed' });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
          }
          return;
        }

        // GET /api/composio/connections — list connected apps
        if (subpath === '/composio/connections' && rq.method === 'GET') {
          try {
            const result = await pinCli('personal connections list');
            if (result.ok && Array.isArray(result.data)) {
              json(200, { connections: result.data });
            } else {
              json(200, { connections: [] });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
          }
          return;
        }

        // 404
        json(404, { error: 'Not found' });
      },
    });

    api.logger.info('Proactive AI v2 ready (routes: /proactive-ai/*)');
  },
};

// ── Default profile seed ──

async function ensureDefaultProfile(api: OpenClawPluginApi) {
  const check = await pinCli('profile get --id default');
  if (check.ok) return;

  api.logger.info('Seeding default profile');

  await pinCli([
    'profile create',
    '--id default',
    '--display-name "User"',
    '--locale en-US',
    `--timezone "${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
    '--summary "A busy professional balancing career, health, finances, and personal growth. Uses Proactive AI to stay on top of decisions and opportunities."',
  ].join(' '));

  const starterGoals = [
    { key: 'career-growth', title: 'Advance career and professional skills', priority: 'high' },
    { key: 'stay-healthy', title: 'Maintain consistent exercise and healthy habits', priority: 'medium' },
    { key: 'financial-plan', title: 'Grow savings and make smart financial decisions', priority: 'medium' },
    { key: 'learn-and-grow', title: 'Dedicate time to learning new skills and ideas', priority: 'medium' },
    { key: 'relationships', title: 'Stay connected with family and close friends', priority: 'medium' },
    { key: 'life-balance', title: 'Protect personal time and avoid burnout', priority: 'high' },
  ];

  for (const g of starterGoals) {
    await pinCli(`profile goals upsert --key ${g.key} --title "${g.title}" --priority ${g.priority}`);
  }

  api.logger.info('Default profile seeded with 6 starter goals');
}
