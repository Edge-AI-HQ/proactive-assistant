import { CoreError } from "../../../core/index.js";
import type { RouteContext } from "../types.js";
import { json, readBody } from "../http-utils.js";
import { buildDefaultCtx } from "../../pipeline/data-access.js";
import {
  applyConnectorHistoryBatches,
  applyProfileIngestPatch,
  profilePatchHasWork,
  runProfileIngestAgent,
  type ConnectorHistoryBatch,
  type ProfileIngestPatch,
} from "../../profile-ingest/agent.js";
import { hostConnectorIngestPersist } from "../../profile-ingest/host-persist.js";

const ctx = buildDefaultCtx();

function coreErrorToHttp(
  res: import("node:http").ServerResponse,
  err: unknown,
): void {
  if (err instanceof CoreError) {
    const status =
      err.type === "not_found"
        ? 404
        : err.type === "validation"
          ? 400
          : err.type === "conflict"
            ? 409
            : 500;
    json(res, status, {
      ok: false,
      error: {
        type: err.type,
        code: err.code,
        message: err.message,
        hint: err.hint,
      },
    });
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { ok: false, error: msg });
  }
}

/**
 * POST /profile/connector-ingest
 * Body: { toolkit?: string, maxRecords?: number (default 50, cap 200), apply?: boolean (default false) }
 */
export async function handleProfileIngest(
  routeCtx: RouteContext,
): Promise<boolean> {
  const { subpath, req, res, api } = routeCtx;
  if (subpath !== "/profile/connector-ingest" || req.method !== "POST") {
    return false;
  }

  try {
    const body = (await readBody(req)) as {
      toolkit?: string;
      maxRecords?: number;
      apply?: boolean;
    };

    const maxRaw = body.maxRecords ?? 50;
    const maxRecords = Math.min(
      200,
      Math.max(1, Math.floor(Number(maxRaw)) || 50),
    );
    const apply = body.apply === true;
    const toolkitLabel = body.toolkit?.trim() || "(auto)";
    api.logger.info(
      `[profile-ingest] request toolkit=${toolkitLabel} maxRecords=${maxRecords} apply=${apply}`,
    );

    let patch: ProfileIngestPatch | null = null;
    let historyBatches: ConnectorHistoryBatch[] = [];
    let rawText = "";
    let subagentCompleted = false;

    try {
      const out = await runProfileIngestAgent(api, {
        toolkit: body.toolkit?.trim() || null,
        maxRecords,
        persistToProfile: apply,
      });
      patch = out.patch;
      historyBatches = out.historyBatches;
      rawText = out.rawText;
      subagentCompleted = out.subagentCompleted;
    } catch (agentErr) {
      const agentMsg =
        agentErr instanceof Error ? agentErr.message : String(agentErr);
      api.logger.warn(
        `[profile-ingest] subagent error toolkit=${toolkitLabel} ${agentMsg}`,
      );
      if (apply && body.toolkit?.trim()) {
        try {
          const hostPersist = await hostConnectorIngestPersist(ctx, {
            toolkit: body.toolkit.trim(),
            maxRecords,
          });
          api.logger.info(
            `[profile-ingest] partial recovery after subagent failure toolkit=${toolkitLabel} rawRows=${hostPersist.rawDataIds.length} skipped=${hostPersist.skipped ?? "none"}`,
          );
          json(res, 200, {
            ok: true,
            apply: true,
            subagentCompleted: false,
            subagentError: agentMsg,
            partialRecovery: true,
            cliDriven: true,
            hostPersist,
            history: null,
            applied: null,
            historyBatches: [],
            patch: null,
            hint: "Subagent failed; host still ran Composio identity snapshot (see hostPersist — connector_raw_data + facts when not skipped).",
          });
          return true;
        } catch (hostErr) {
          api.logger.warn(
            `[profile-ingest] partial recovery host error ${hostErr instanceof Error ? hostErr.message : String(hostErr)}`,
          );
        }
      }
      throw agentErr;
    }

    const hasHistory = historyBatches.length > 0;
    const hasProfile = patch != null && profilePatchHasWork(patch);

    if (!apply) {
      api.logger.info(`[profile-ingest] ok (dry-run) toolkit=${toolkitLabel}`);
      json(res, 200, {
        ok: true,
        apply: false,
        subagentCompleted,
        applied: null,
        history: null,
        historyBatches,
        patch,
        rawPreview: rawText.slice(0, 2000),
        hint: "Dry-run: no DB writes from the subagent. Re-run with apply:true so it can persist via pin CLI (connector_raw + profile).",
      });
      return true;
    }

    let historyApplied: { storedRawDataIds: string[] } | null = null;
    if (hasHistory) {
      historyApplied = await applyConnectorHistoryBatches(ctx, historyBatches);
      api.logger.info(
        `[profile-ingest] stored connector history batches=${historyBatches.length} toolkit=${toolkitLabel}`,
      );
    }

    let profileApplied = null;
    if (hasProfile && patch) {
      profileApplied = await applyProfileIngestPatch(ctx, patch);
      api.logger.info(
        `[profile-ingest] applied host profile patch toolkit=${toolkitLabel}`,
      );
    }

    const cliOnly = !hasHistory && !hasProfile;
    if (cliOnly) {
      api.logger.info(
        `[profile-ingest] apply complete (cli-driven, no host merge) toolkit=${toolkitLabel}`,
      );
    }

    let hostPersist: Awaited<
      ReturnType<typeof hostConnectorIngestPersist>
    > | null = null;
    if (apply && cliOnly && body.toolkit?.trim()) {
      try {
        hostPersist = await hostConnectorIngestPersist(ctx, {
          toolkit: body.toolkit.trim(),
          maxRecords,
        });
        api.logger.info(
          `[profile-ingest] host fallback toolkit=${toolkitLabel} skipped=${hostPersist.skipped ?? "none"} rawRows=${hostPersist.rawDataIds.length} facts=${hostPersist.appliedFacts.length}`,
        );
      } catch (err) {
        api.logger.warn(
          `[profile-ingest] host fallback error toolkit=${toolkitLabel} ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    json(res, 200, {
      ok: true,
      apply: true,
      subagentCompleted,
      cliDriven: cliOnly,
      hostPersist,
      history: historyApplied,
      applied: profileApplied,
      historyBatches,
      patch,
      hint: cliOnly
        ? hostPersist?.rawDataIds?.length
          ? "Subagent used pin CLI when possible; host also wrote connector_raw_data + facts via Composio identity (host_connector_ingest)."
          : "Subagent was expected to persist via pin CLI; host fallback did not write rows (see hostPersist.skipped)."
        : "Host merged legacy JSON patch and/or connector_history_batches (if returned) in addition to any CLI writes.",
    });
    return true;
  } catch (err) {
    coreErrorToHttp(res, err);
    return true;
  }
}
