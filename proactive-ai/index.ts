/**
 * OpenClaw Plugin: Proactive AI (v2)
 *
 * Registers:
 * 1. Skills (via openclaw.plugin.json) — pin-cli command reference for agents
 * 2. `/generate` command — manually trigger intent card generation
 * 3. HTTP routes on OpenClaw gateway — UI + API (no separate server)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { pinCli } from './src/pipeline/pin-cli.js';
import { runPipeline, DEFAULT_PIPELINE_OPTIONS } from './src/pipeline/orchestrator.js';
import { buildChatSystemPrompt, buildChatFirstMessage } from './src/agents/chat.js';
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
const uiCandidates = [
  resolve(thisDir, 'ui', 'index.html'),          // from dist/ (plugin mode, compiled)
  resolve(thisDir, 'dist', 'ui', 'index.html'),   // from root (plugin mode, source)
  resolve(thisDir, 'index.html'),                  // fallback to dev HTML
];
const uiPath = uiCandidates.find(p => existsSync(p)) ?? resolve(thisDir, 'index.html');
const UI_HTML = readFileSync(uiPath, 'utf-8');

// ── Run persistence ──

const MAX_STORED_RUNS = 5;

interface StoredRun {
  id: string;
  completedAt: string;
  totalIterations: number;
  finalCards: unknown[];
  scoreMap: Record<string, unknown>;
}

interface RunStore {
  runs: StoredRun[];
}

function getRunStorePath(): string {
  const home = process.env['HOME'] ?? '/tmp';
  const dir = resolve(home, '.openclaw', 'proactive-ai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, 'runs.json');
}

function loadRunStore(): RunStore {
  try {
    const raw = readFileSync(getRunStorePath(), 'utf-8');
    return JSON.parse(raw) as RunStore;
  } catch {
    return { runs: [] };
  }
}

function saveRun(run: StoredRun): void {
  const store = loadRunStore();
  store.runs.unshift(run);
  if (store.runs.length > MAX_STORED_RUNS) {
    store.runs = store.runs.slice(0, MAX_STORED_RUNS);
  }
  writeFileSync(getRunStorePath(), JSON.stringify(store, null, 2));
}

// ── Plugin Entry ──

let pipelineRunning = false;
let pipelinePhase: string | null = null;
let pipelineIteration: number | null = null;

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
        r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        r.end(html);
      },
    });

    const MIME_TYPES: Record<string, string> = {
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
      '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    };

    api.registerHttpRoute({
      path: '/proactive-ai/assets',
      auth: 'plugin',
      match: 'prefix',
      async handler(req, res) {
        const r = res as import('node:http').ServerResponse;
        const rq = req as import('node:http').IncomingMessage;
        const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
        const assetName = url.pathname.replace(/^\/proactive-ai\/assets\/?/, '');
        if (!assetName || assetName.includes('..')) {
          r.writeHead(404); r.end(); return;
        }
        const publicDir = resolve(thisDir, 'public');
        const distPublicDir = resolve(thisDir, '..', 'public');
        const distDir = resolve(thisDir, 'ui');
        let filePath = resolve(publicDir, assetName);
        if (!existsSync(filePath)) filePath = resolve(distPublicDir, assetName);
        if (!existsSync(filePath)) filePath = resolve(distDir, assetName);
        if (!existsSync(filePath)) { r.writeHead(404); r.end(); return; }

        const ext = '.' + assetName.split('.').pop();
        r.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        const { createReadStream } = await import('node:fs');
        createReadStream(filePath).pipe(r);
      },
    });

    const createJsonResponder = (res: unknown) => {
      const r = res as import('node:http').ServerResponse;
      return (status: number, data: unknown) => {
        r.writeHead(status, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify(data));
      };
    };

    const readJsonBody = (req: unknown): Promise<Record<string, unknown>> => {
      const rq = req as import('node:http').IncomingMessage;
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        rq.on('data', (c: Buffer) => chunks.push(c));
        rq.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve({}); }
        });
        rq.on('error', reject);
      });
    };

    api.registerHttpRoute({
      path: '/proactive-ai/rpc/composio/status',
      auth: 'plugin',
      match: 'exact',
      async handler(_req, res) {
        const json = createJsonResponder(res);
        try {
          const result = await pinCli('personal status');
          json(200, result.ok ? result.data : { configured: false });
        } catch {
          json(200, { configured: false });
        }
      },
    });

    api.registerHttpRoute({
      path: '/proactive-ai/rpc/composio/connections',
      auth: 'plugin',
      match: 'exact',
      async handler(_req, res) {
        const json = createJsonResponder(res);
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
      },
    });

    api.registerHttpRoute({
      path: '/proactive-ai/rpc/composio/connect',
      auth: 'plugin',
      match: 'exact',
      async handler(req, res) {
        const json = createJsonResponder(res);
        try {
          const body = await readJsonBody(req);
          const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
          if (!toolkit) {
            json(400, { error: 'Missing toolkit' });
            return;
          }
          const result = await pinCli(`personal connect --toolkit ${toolkit}`);
          if (result.ok) {
            json(200, result.data);
          } else {
            json(400, { error: result.error ?? 'Connect failed' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          json(500, { error: msg });
        }
      },
    });

    api.registerHttpRoute({
      path: '/proactive-ai/rpc/composio/wait',
      auth: 'plugin',
      match: 'exact',
      async handler(req, res) {
        const json = createJsonResponder(res);
        try {
          const body = await readJsonBody(req);
          const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
          if (!toolkit) {
            json(400, { error: 'Missing toolkit' });
            return;
          }
          const result = await pinCli(`personal wait --toolkit ${toolkit}`);
          if (result.ok) {
            json(200, result.data);
          } else {
            json(400, { error: result.error ?? 'Wait failed' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          json(500, { error: msg });
        }
      },
    });

    api.registerHttpRoute({
      path: '/proactive-ai/rpc',
      auth: 'plugin',
      match: 'prefix',
      async handler(req, res) {
        const r = res as import('node:http').ServerResponse;
        const rq = req as import('node:http').IncomingMessage;
        const url = new URL(rq.url ?? '/', `http://${rq.headers.host ?? 'localhost'}`);
        const subpath = url.pathname.replace(/^\/proactive-ai\/rpc\/?/, '/');

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
            if (event.type === 'pipeline:iteration') {
              pipelinePhase = (event.data as { phase?: string }).phase ?? null;
              pipelineIteration = (event.data as { iteration?: number }).iteration ?? null;
            }
          };

          pipelineRunning = true;

          try {
            const maxIter = parseInt(url.searchParams.get('iterations') ?? '', 10)
              || DEFAULT_PIPELINE_OPTIONS.maxIterations;

            const pipelineResult = await runPipeline(
              api,
              { ...DEFAULT_PIPELINE_OPTIONS, maxIterations: maxIter },
              sendEvent,
            );
            saveRun({
              id: `run_${Date.now().toString(36)}`,
              completedAt: new Date().toISOString(),
              totalIterations: pipelineResult.totalIterations,
              finalCards: pipelineResult.finalCards,
              scoreMap: {},
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            api.logger.error(`Pipeline error: ${message}`);
            sendEvent({ type: 'pipeline:error', data: { message } });
          } finally {
            pipelineRunning = false;
            pipelinePhase = null;
            pipelineIteration = null;
            r.end();
          }
          return;
        }

        // GET /api/status — current pipeline state + last result (from file)
        if (subpath === '/status' && rq.method === 'GET') {
          json(200, {
            ok: true,
            pipelineRunning,
            phase: pipelinePhase,
            iteration: pipelineIteration,
            lastResult: loadRunStore().runs[0] ?? null,
          });
          return;
        }

        // GET /api/runs — all stored pipeline runs (for Timeline)
        if (subpath === '/runs' && rq.method === 'GET') {
          json(200, { ok: true, runs: loadRunStore().runs });
          return;
        }

        // GET /api/chat/history — retrieve persisted messages for a card session
        if (subpath === '/chat/history' && rq.method === 'GET') {
          const sessionKey = url.searchParams.get('sessionKey');
          if (!sessionKey) {
            json(400, { error: 'Missing sessionKey' });
            return;
          }
          try {
            const result = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 50 });
            const firstTurnPrompt = buildChatFirstMessage();
            const seenAssistant = new Set<string>();
            const messages = (result.messages as Array<{ role?: string; content?: unknown }>)
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map((m, i) => ({
                id: `${m.role}-${i}`,
                role: m.role as string,
                content: extractTextContent(m.content),
              }))
              .filter(m => {
                if (!m.content) return false;
                if (m.role === 'user' && m.content.includes(firstTurnPrompt)) return false;
                if (m.role === 'assistant') {
                  if (seenAssistant.has(m.content)) return false;
                  seenAssistant.add(m.content);
                }
                return true;
              });
            json(200, { ok: true, sessionKey, messages });
          } catch {
            json(200, { ok: true, sessionKey, messages: [] });
          }
          return;
        }

        // POST /api/chat → conversational agent session per intent card
        if (subpath === '/chat' && rq.method === 'POST') {
          const body = await readBody() as {
            message?: string;
            sessionKey?: string;
            cardContext?: string;
          };

          const userMessage = (body.message as string | undefined)?.trim();
          const isFirstTurn = !!body.cardContext;
          const sessionKey = (body.sessionKey as string) ?? `agent:main:proactive-ai:chat:${Date.now().toString(36)}`;

          const systemPrompt = isFirstTurn
            ? buildChatSystemPrompt({ cardContext: body.cardContext as string })
            : undefined;

          const agentMessage = isFirstTurn
            ? buildChatFirstMessage()
            : userMessage;

          if (!agentMessage) {
            json(400, { error: 'Missing message' });
            return;
          }

          try {
            const { runId } = await api.runtime.subagent.run({
              sessionKey,
              message: agentMessage,
              ...(systemPrompt && { extraSystemPrompt: systemPrompt }),
              idempotencyKey: `proactive-ai:chat:${Date.now().toString(36)}`,
              deliver: false,
            });

            const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 120_000 });

            if (result.status !== 'ok') {
              json(500, { ok: false, error: result.error ?? `Agent failed: ${result.status}` });
              return;
            }

            const messages = await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 5 });
            const assistantMsgs = (messages.messages as Array<{ role?: string; content?: unknown }>)
              .filter(m => m.role === 'assistant');
            const last = assistantMsgs[assistantMsgs.length - 1];

            json(200, { ok: true, sessionKey, reply: extractTextContent(last?.content) });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            api.logger.error(`Chat error: ${message}`);
            json(500, { ok: false, error: message });
          }
          return;
        }

        // POST /api/feedback — record user feedback via pin-cli
        if (subpath === '/feedback' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const kind = String(body['kind'] ?? '').trim();
            if (!kind) {
              json(400, { error: 'Missing kind' });
              return;
            }

            const parts = ['feedback log', `--kind ${kind}`];
            if (body['action'])       parts.push(`--action ${body['action']}`);
            if (body['intentCardId']) parts.push(`--intent-card-id ${body['intentCardId']}`);
            if (body['basket'])       parts.push(`--basket ${body['basket']}`);
            if (body['source'])       parts.push(`--source ${body['source']}`);
            else                      parts.push('--source user_direct');

            const result = await pinCli(parts.join(' '));
            json(result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
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

        // POST /api/composio/connect — initiate OAuth for a toolkit
        if (subpath === '/composio/connect' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
            if (!toolkit) {
              json(400, { error: 'Missing toolkit' });
              return;
            }
            const result = await pinCli(`personal connect --toolkit ${toolkit}`);
            if (result.ok) {
              json(200, result.data);
            } else {
              json(400, { error: result.error ?? 'Connect failed' });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
          }
          return;
        }

        // POST /api/composio/wait — poll until OAuth connection is active
        if (subpath === '/composio/wait' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const toolkit = String(body['toolkit'] ?? '').trim().toLowerCase();
            if (!toolkit) {
              json(400, { error: 'Missing toolkit' });
              return;
            }
            const result = await pinCli(`personal wait --toolkit ${toolkit}`);
            if (result.ok) {
              json(200, result.data);
            } else {
              json(400, { error: result.error ?? 'Wait failed' });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
          }
          return;
        }

        // ── Profile routes ──

        // GET /api/profile/goals — list user goals
        if (subpath === '/profile/goals' && rq.method === 'GET') {
          try {
            const result = await pinCli('profile goals list');
            if (result.ok) {
              json(200, { ok: true, goals: result.data });
            } else {
              json(200, { ok: true, goals: [] });
            }
          } catch {
            json(200, { ok: true, goals: [] });
          }
          return;
        }

        // POST /api/profile/goals — upsert a goal
        if (subpath === '/profile/goals' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const key = String(body['key'] ?? '').trim();
            const title = String(body['title'] ?? '').trim();
            const priority = String(body['priority'] ?? 'medium').trim();
            if (!key || !title) {
              json(400, { error: 'Missing key or title' });
              return;
            }
            const result = await pinCli(`profile goals upsert --key ${key} --title "${title}" --priority ${priority}`);
            json(result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            json(500, { error: msg });
          }
          return;
        }

        // POST /api/profile/goals/close — close a goal
        if (subpath === '/profile/goals/close' && rq.method === 'POST') {
          try {
            const body = await readBody();
            const key = String(body['key'] ?? '').trim();
            if (!key) {
              json(400, { error: 'Missing key' });
              return;
            }
            const result = await pinCli(`profile goals close --key ${key}`);
            json(result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
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

// ── Helpers ──

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join('\n')
      .trim();
  }
  return '';
}

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
