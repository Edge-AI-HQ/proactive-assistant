import type { RouteContext } from '../../types/server.js';
import { json } from '../http-utils.js';
import { pipelineState } from '../../state.js';
import { DEFAULT_PIPELINE_OPTIONS } from '../../pipeline/orchestrator.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { executeIncrementalPipeline } from '../pipeline-runner.js';

export async function handleAutoRun(ctx: RouteContext): Promise<boolean> {
  const { subpath, req, res, api } = ctx;
  if (subpath !== '/auto-run' || req.method !== 'POST') return false;

  if (pipelineState.running) {
    json(res, 409, { ok: false, error: 'Pipeline is already running' });
    return true;
  }

  const pluginConfig = api.pluginConfig as Record<string, unknown>;
  const minAgeMs = Number(pluginConfig['auto_process_min_age_ms'] ?? DEFAULT_CONFIG.auto_process_min_age_ms);
  const cooldownMs = Number(pluginConfig['auto_loop_min_interval_ms'] ?? DEFAULT_CONFIG.auto_loop_min_interval_ms);
  const maxIterations = Number(pluginConfig['max_iterations'] ?? DEFAULT_PIPELINE_OPTIONS.maxIterations);
  const agentTimeoutMs = Number(pluginConfig['agent_timeout_ms'] ?? DEFAULT_PIPELINE_OPTIONS.agentTimeoutMs);

  try {
    const result = await executeIncrementalPipeline(api, {
      trigger: 'auto',
      maxIterations,
      agentTimeoutMs,
      cooldownMs,
      enforceCooldown: true,
    });
    if ('skipped' in result) {
      json(res, 200, result);
      return true;
    }
    api.logger.info(`[auto-loop] completed, consumed pending=${result.consumedPending}, cards=${result.cards}`);
    json(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    api.logger.error(`[auto-loop] failed: ${message}`);
    json(res, 500, { ok: false, error: message });
  }

  return true;
}
