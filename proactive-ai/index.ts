/**
 * OpenClaw Plugin: Proactive AI (v2)
 *
 * Thin entry point that wires engine logic to OpenClaw.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DEFAULT_CONFIG, type ProactiveAIConfig } from "./src/engine/config.js";
import { shared } from "./src/engine/state.js";
import { ensureDefaultProfile } from "./src/engine/pipeline/profile-seed.js";
import { runPipeline } from "./src/engine/pipeline/orchestrator.js";
import { startAutoLoop } from "./src/engine/scheduler/auto-loop.js";
import { createUiHandler } from "./src/engine/server/ui-route.js";
import { createAssetsHandler } from "./src/engine/server/assets-route.js";
import { createApiHandler } from "./src/engine/server/api-router.js";
import { DEFAULT_GENERATION_LANGUAGE } from "./src/engine/generation-language.js";
import { warmIdentityCache } from "./src/engine/server/identity-warmup.js";
import {
  applyConnectorHistoryBatches,
  applyProfileIngestPatch,
  profilePatchHasWork,
  runProfileIngestAgent,
} from "./src/engine/profile-ingest/agent.js";
import { hostConnectorIngestPersist } from "./src/engine/profile-ingest/host-persist.js";
import { buildDefaultCtx } from "./src/engine/pipeline/data-access.js";

const pluginDir = dirname(fileURLToPath(import.meta.url));

function parseProfileIngestFlags(argLine: string): {
  apply: boolean;
  maxRecords: number;
} {
  const apply = /--apply\b/.test(argLine);
  const maxMatch = argLine.match(/--max-records\s+(\d+)/);
  const maxRecords = Math.min(
    200,
    Math.max(1, maxMatch ? parseInt(maxMatch[1], 10) : 50),
  );
  return { apply, maxRecords };
}

async function runOpenClawProfileIngest(
  api: OpenClawPluginApi,
  opts: { toolkit: string | null; argLine: string },
): Promise<string> {
  const { apply, maxRecords } = parseProfileIngestFlags(opts.argLine);
  try {
    const { patch, historyBatches, rawText, subagentCompleted } =
      await runProfileIngestAgent(api, {
        toolkit: opts.toolkit,
        maxRecords,
        persistToProfile: apply,
      });
    const hasHistory = historyBatches.length > 0;
    const hasProfile = patch != null && profilePatchHasWork(patch);
    if (!apply) {
      return `${JSON.stringify(
        {
          ok: true,
          dryRun: true,
          subagentCompleted,
          historyBatches,
          patch,
          hint: "Re-run with --apply so the subagent may persist via pin CLI (connector_raw + profile).",
        },
        null,
        2,
      )}\n\nraw (truncated):\n${rawText.slice(0, 800)}`;
    }
    const ctx = buildDefaultCtx();
    const historyApplied = hasHistory
      ? await applyConnectorHistoryBatches(ctx, historyBatches)
      : null;
    const profileApplied =
      hasProfile && patch ? await applyProfileIngestPatch(ctx, patch) : null;
    const cliOnly = !hasHistory && !hasProfile;
    let hostPersist: Awaited<
      ReturnType<typeof hostConnectorIngestPersist>
    > | null = null;
    if (cliOnly && opts.toolkit?.trim()) {
      try {
        hostPersist = await hostConnectorIngestPersist(ctx, {
          toolkit: opts.toolkit.trim(),
          maxRecords,
        });
      } catch {
        /* logged in gateway if needed */
      }
    }
    return JSON.stringify(
      {
        ok: true,
        subagentCompleted,
        cliDriven: cliOnly,
        hostPersist,
        history: historyApplied,
        applied: profileApplied,
        patch,
      },
      null,
      2,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `profile-ingest failed: ${msg}`;
  }
}

export default {
  id: "proactive-ai",
  configSchema: {
    type: "object" as const,
    properties: {
      max_iterations: { type: "number" as const, default: 3 },
      cards_per_iteration: { type: "number" as const, default: 8 },
      agent_timeout_ms: { type: "number" as const, default: 300_000 },
      auto_poll_enabled: { type: "boolean" as const, default: true },
      auto_ingest_interval_ms: { type: "number" as const, default: 300_000 },
      auto_detect_interval_ms: { type: "number" as const, default: 60_000 },
      auto_loop_min_interval_ms: { type: "number" as const, default: 900_000 },
      auto_process_min_age_ms: { type: "number" as const, default: 120_000 },
      auto_poll_world_limit: { type: "number" as const, default: 20 },
      auto_poll_profile_id: { type: "string" as const, default: "default" },
      auto_poll_providers: {
        type: "string" as const,
        default: "sec,fed,google-news",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config: ProactiveAIConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as Partial<ProactiveAIConfig>),
    };

    if (!shared.initialized) {
      api.logger.info("Proactive AI v2 loading");
      shared.initialized = true;
    } else {
      api.logger.debug("Proactive AI v2 reload (runtime plugin re-resolve)");
    }

    if (!shared.profileSeeded) {
      shared.profileSeeded = true;
      ensureDefaultProfile(api).catch((err) => {
        api.logger.warn(
          `Failed to seed default profile: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    // ── /generate command ──

    api.registerCommand({
      name: "profile-ingest",
      acceptsArgs: true,
      description:
        "Connector ingest: subagent uses pin + Composio; with --apply, host also persists identity to connector_raw_data + facts when needed (--toolkit <slug> recommended)",
      async handler(...raw: unknown[]) {
        const argLine = raw.map(String).join(" ").trim();
        const tkMatch = argLine.match(/--toolkit\s+(\S+)/);
        const toolkit = tkMatch ? tkMatch[1] : null;
        return runOpenClawProfileIngest(api, { toolkit, argLine });
      },
    });

    api.registerCommand({
      name: "profile-ingest-gmail",
      acceptsArgs: true,
      description:
        "Test shortcut: same as profile-ingest --toolkit gmail (optional --apply, --max-records N)",
      async handler(...raw: unknown[]) {
        const argLine = raw.map(String).join(" ").trim();
        return runOpenClawProfileIngest(api, { toolkit: "gmail", argLine });
      },
    });

    api.registerCommand({
      name: "generate",
      description: "Trigger intent card generation pipeline",
      async handler() {
        api.logger.info("Manual intent card generation triggered");
        try {
          const result = await runPipeline(api, {
            maxIterations: config.max_iterations,
            cardsPerIteration: config.cards_per_iteration,
            agentTimeoutMs: config.agent_timeout_ms,
            outputLanguage: DEFAULT_GENERATION_LANGUAGE,
          });
          return `Generated ${result.finalCards.length} intent cards in ${result.totalIterations} iterations.\n\n${JSON.stringify(result.finalCards, null, 2)}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Pipeline failed: ${msg}`;
        }
      },
    });

    // ── HTTP routes ──

    const gwAuth = (api.config as Record<string, unknown>)?.["gateway"] as
      | Record<string, unknown>
      | undefined;
    const gwToken =
      ((gwAuth?.["auth"] as Record<string, unknown>)?.["token"] as string) ??
      "";
    api.registerHttpRoute({
      path: "/proactive-ai",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: createUiHandler(pluginDir, gwToken),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/assets",
      auth: "plugin",
      match: "prefix",
      replaceExisting: true,
      handler: createAssetsHandler(pluginDir),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/api",
      auth: "gateway",
      match: "prefix",
      replaceExisting: true,
      handler: createApiHandler(api),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/rpc",
      auth: "plugin",
      match: "prefix",
      replaceExisting: true,
      handler: createApiHandler(api),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/rpc/composio/status",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: createApiHandler(api),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/rpc/composio/connections",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: createApiHandler(api),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/rpc/composio/connect",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: createApiHandler(api),
    });
    api.registerHttpRoute({
      path: "/proactive-ai/rpc/composio/wait",
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: createApiHandler(api),
    });

    startAutoLoop(api, config);

    warmIdentityCache(api.logger).catch(() => {});

    api.logger.info("Proactive AI v2 ready (routes: /proactive-ai/*)");
  },
};
