/**
 * OpenClaw Plugin: Proactive AI (v2)
 *
 * Registers:
 * 1. `pin` tool — shell bridge to pin-cli for subagents
 * 2. `/generate` command — manually trigger intent card generation
 * 3. HTTP routes on OpenClaw gateway — UI + API (no separate server)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { pinCli, formatForAgent } from './src/pipeline/pin-cli.js';
import { runPipeline, DEFAULT_PIPELINE_OPTIONS } from './src/pipeline/orchestrator.js';
import type { ServerEvent } from './src/types/index.js';

// ── Plugin Config ──

interface ProactiveAIConfig {
  max_iterations: number;
  agent_timeout_ms: number;
}

const DEFAULT_CONFIG: ProactiveAIConfig = {
  max_iterations: 1,
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
      max_iterations: { type: 'number' as const, default: 1 },
      agent_timeout_ms: { type: 'number' as const, default: 300_000 },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: ProactiveAIConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<ProactiveAIConfig>),
    };

    api.logger.info('Proactive AI v2 loading');

    // ── 1. Register `pin` tool for subagents ──

    api.registerTool({
      name: 'pin',
      description: [
        'PIN CLI — deterministic data tool for user profile, personal feed, world context, feedback, and push management.',
        'Call with a command string, e.g.: pin({ command: "profile get --id default" })',
        'All commands return JSON envelopes with { ok, data, error, meta }.',
        'Use `sys schema` to discover all available commands.',
        'Add --json for structured output (auto-appended if missing).',
      ].join('\n'),
      parameters: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string' as const,
            description: 'PIN CLI command, e.g. "profile get --id default", "personal search --query meetings --json"',
          },
        },
        required: ['command'] as string[],
      },
      async execute(_toolCallId: string, toolArgs: Record<string, unknown>) {
        const command = String(toolArgs['command'] ?? '').trim();
        if (!command) {
          return 'Error: empty command. Usage: pin({ command: "profile get --id default" })';
        }

        try {
          const result = await pinCli(command);
          return formatForAgent(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.warn(`pin tool error: ${msg}`);
          return `Error executing pin-cli: ${msg}`;
        }
      },
    });

    // ── 2. Register /generate command (chat interface) ──

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
    // Single prefix-matched route handles all /proactive-ai/* requests

    api.registerHttpRoute({
      path: '/proactive-ai',
      auth: 'plugin',
      match: 'prefix',
      async handler(req, res) {
        const r = res as import('node:http').ServerResponse;
        const rq = req as import('node:http').IncomingMessage;
        const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
        const subpath = url.pathname.replace(/^\/proactive-ai\/?/, '/');

        // GET / → placeholder frontend
        if ((subpath === '/' || subpath === '') && rq.method === 'GET') {
          r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          r.end(UI_HTML);
          return;
        }

        // GET /api/health → health check
        if (subpath === '/api/health' && rq.method === 'GET') {
          r.writeHead(200, { 'Content-Type': 'application/json' });
          r.end(JSON.stringify({ ok: true, pipelineRunning }));
          return;
        }

        // GET /api/generate → SSE pipeline stream
        if (subpath === '/api/generate' && rq.method === 'GET') {
          if (pipelineRunning) {
            r.writeHead(409, { 'Content-Type': 'application/json' });
            r.end(JSON.stringify({ error: 'Pipeline is already running' }));
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

        // 404
        r.writeHead(404, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ error: 'Not found' }));
      },
    });

    api.logger.info('Proactive AI v2 ready (routes: /proactive-ai/*)');
  },
};
