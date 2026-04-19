/**
 * Host-side connector ingest persistence: does not depend on the subagent
 * returning JSON or calling `pin profile connector-raw append`.
 * Uses Composio identity tools + local profile DB when an ACTIVE connection exists.
 */

import type { CoreContext } from "../../core/context.js";
import { extractIdentity } from "../../core/domains/personal/extract_identity.js";
import * as personal from "../../core/domains/personal/service.js";
import { createPersonalProvider } from "../../core/domains/personal/provider.js";
import {
  appendConnectorRawData,
  setFact,
} from "../../core/domains/profile/service.js";

const MAX_PAYLOAD_BYTES = 480 * 1024;

export interface HostConnectorPersistResult {
  rawDataIds: string[];
  appliedFacts: string[];
  skipped?: string;
}

function normalizeToolkit(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * When the subagent completed without legacy batches/patch, persist at least one
 * bounded identity snapshot to `connector_raw_data` and mirror key fields into facts.
 */
export async function hostConnectorIngestPersist(
  ctx: CoreContext,
  input: { toolkit: string; maxRecords: number },
): Promise<HostConnectorPersistResult> {
  const toolkit = normalizeToolkit(input.toolkit);
  const rawDataIds: string[] = [];
  const appliedFacts: string[] = [];

  if (!toolkit) {
    return { rawDataIds, appliedFacts, skipped: "empty_toolkit" };
  }

  const connections = await personal.listConnections(ctx, {
    toolkits: toolkit,
  });
  const active = connections.find(
    (c) =>
      normalizeToolkit(c.toolkit) === toolkit &&
      c.status === "ACTIVE" &&
      Boolean(c.connectedAccountId),
  );
  if (!active?.connectedAccountId) {
    return { rawDataIds, appliedFacts, skipped: "no_active_connection" };
  }

  const provider = createPersonalProvider(ctx);
  const identity = await provider.resolveAccountIdentity(
    active.toolkit,
    active.connectedAccountId,
  );
  if (!identity || Object.keys(identity).length === 0) {
    return {
      rawDataIds,
      appliedFacts,
      skipped: "identity_tool_unavailable_or_empty",
    };
  }

  const payloadObj = {
    schema: "host_identity_snapshot_v1" as const,
    toolkit: active.toolkit,
    connected_account_id: active.connectedAccountId,
    captured_via: "host_connector_ingest",
    max_records_bound: input.maxRecords,
    identity,
  };
  let payloadJson = JSON.stringify(payloadObj);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    payloadJson = payloadJson.slice(0, MAX_PAYLOAD_BYTES) + "\n/* truncated */";
  }

  const row = await appendConnectorRawData(ctx, {
    toolkit: active.toolkit,
    connectedAccountId: active.connectedAccountId,
    toolSlug: "IDENTITY_GET",
    ingestSource: "host_connector_ingest",
    payloadJson,
    capturedAt: new Date().toISOString(),
  });
  rawDataIds.push(row.id);

  const label = extractIdentity(identity);
  if (label) {
    const key = `connector.${toolkit}.identity_label`;
    await setFact(ctx, { key, valueJson: JSON.stringify(label) });
    appliedFacts.push(key);
  }

  const id = identity as Record<string, unknown>;
  const emailRaw =
    typeof id.email === "string"
      ? id.email.trim()
      : typeof id.primaryEmailAddress === "string"
        ? String(id.primaryEmailAddress).trim()
        : "";
  if (emailRaw.includes("@")) {
    const key = `connector.${toolkit}.email`;
    await setFact(ctx, { key, valueJson: JSON.stringify(emailRaw) });
    appliedFacts.push(key);
  }

  return { rawDataIds, appliedFacts };
}
