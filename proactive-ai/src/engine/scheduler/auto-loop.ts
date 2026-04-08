import http from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { ProactiveAIConfig } from '../config.js';
import { autoPollState, gatewayOriginState, pipelineState } from '../state.js';
import { pinCliData } from '../pipeline/pin-cli.js';
import {
  loadAutoLoopState,
} from '../pending-store.js';
import { getAutoGenerate } from '../server/local-settings.js';

async function runIngest(api: OpenClawPluginApi, config: ProactiveAIConfig): Promise<void> {
  if (autoPollState.ingestInFlight) return;
  autoPollState.ingestInFlight = true;
  try {
    const result = await pinCliData<{
      inserted: { world: number; personal: number; total: number };
      pending: number;
    }>(['ingest', 'run', '--domains', 'world']);
    api.logger.info(
      `[auto-ingest] added world=${result.inserted.world}, personal=${result.inserted.personal}, pending=${result.pending}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-ingest] failed: ${msg}`);
  } finally {
    autoPollState.ingestInFlight = false;
  }
}

function parseIsoTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function triggerAutoRunViaGateway(api: OpenClawPluginApi): Promise<{ ok: boolean; status: number; body: string }> {
  const origin = gatewayOriginState.gatewayOrigin;
  if (!origin) {
    api.logger.warn('[auto-loop] skipped: gateway origin unavailable');
    return { ok: false, status: 0, body: 'gateway origin unavailable' };
  }

  const gwAuth = (api.config as Record<string, unknown>)?.['gateway'] as Record<string, unknown> | undefined;
  const token = ((gwAuth?.['auth'] as Record<string, unknown>)?.['token'] as string) ?? '';
  if (!token) {
    api.logger.warn('[auto-loop] skipped: gateway token unavailable');
    return { ok: false, status: 0, body: 'gateway token unavailable' };
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${origin}/proactive-ai/api/auto-run`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Length': '0',
        },
        timeout: 300_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 500,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('auto-run request timed out')));
    req.end();
  });
}

async function runDetectAndLoop(api: OpenClawPluginApi, config: ProactiveAIConfig): Promise<void> {
  if (autoPollState.loopInFlight) return;
  if (pipelineState.running) return;
  if (!getAutoGenerate()) return;

  autoPollState.loopInFlight = true;
  try {
    const loopState = loadAutoLoopState();
    const lastFinishedMs = parseIsoTimestamp(loopState.lastFinishedAt);
    const cooldownMs = Math.max(0, config.auto_loop_min_interval_ms);
    if (lastFinishedMs !== null && Date.now() - lastFinishedMs < cooldownMs) {
      api.logger.info(
        `[auto-loop] skipped: cooldown active waitMs=${cooldownMs - (Date.now() - lastFinishedMs)}`,
      );
      return;
    }
    const response = await triggerAutoRunViaGateway(api);
    if (!response.ok) {
      api.logger.error(`[auto-loop] auto-run request failed status=${response.status} body=${response.body}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-loop] failed: ${msg}`);
  } finally {
    autoPollState.loopInFlight = false;
  }
}

export function startAutoLoop(api: OpenClawPluginApi, config: ProactiveAIConfig): void {
  if (!config.auto_poll_enabled) {
    api.logger.info('[auto-loop] disabled by config');
    return;
  }
  if (autoPollState.started) return;
  autoPollState.started = true;

  void runIngest(api, config);
  autoPollState.ingestTimer = setInterval(() => {
    void runIngest(api, config);
  }, config.auto_ingest_interval_ms);

  autoPollState.detectTimer = setInterval(() => {
    void runDetectAndLoop(api, config);
  }, config.auto_detect_interval_ms);

  api.logger.info(
    `[auto-loop] started ingest=${config.auto_ingest_interval_ms}ms detect=${config.auto_detect_interval_ms}ms minAge=${config.auto_process_min_age_ms}ms cooldown=${config.auto_loop_min_interval_ms}ms`,
  );
}
