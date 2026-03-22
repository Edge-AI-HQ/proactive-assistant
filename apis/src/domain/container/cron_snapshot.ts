import WebSocket from "ws";
import type { GatewayTarget } from "./contracts.js";
import { gatewayHostHeaders } from "./contracts.js";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_ROLE,
  GATEWAY_CLIENT_SCOPES,
} from "../gateway/gateway_constants.js";
import {
  setAssistantRuntimeMetadataKey,
  deleteAssistantRuntimeMetadataKey,
} from "../common/db/runtimeRepository.js";

// ---------------------------------------------------------------------------
// Gateway RPC: fetch cron schedules and persist earliest next-run time
//
// Used by the idle-suspend scan to snapshot cron schedule data before
// suspending a container, so the wake-on-cron scan knows when to resume it.
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 5_000;
const CONNECT_REQUEST_ID = "cron-snapshot-connect";
const CRON_LIST_REQUEST_ID = "cron-snapshot-list";

/**
 * Connect to a running container's gateway, call `cron.list`, and return the
 * earliest `state.nextRunAtMs` among enabled jobs — or `null` if there are
 * no enabled cron jobs.
 */
export async function fetchEarliestCronNextRunMs(
  target: GatewayTarget,
  gatewayToken: string,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(value);
    };

    const timeout = setTimeout(() => finish(null), RPC_TIMEOUT_MS);
    timeout.unref();

    const ws = new WebSocket(target.wsBaseUrl, {
      maxPayload: 2 * 1024 * 1024,
      headers: gatewayHostHeaders(target),
    });

    ws.on("error", () => { clearTimeout(timeout); finish(null); });
    ws.on("close", () => { clearTimeout(timeout); finish(null); });

    ws.on("open", () => {
      // Step 1: authenticate via `connect`
      ws.send(JSON.stringify({
        type: "req",
        id: CONNECT_REQUEST_ID,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: GATEWAY_CLIENT_ID,
            version: "dev",
            platform: process.platform,
            mode: "backend",
            instanceId: "pinai-cron-snapshot",
          },
          role: GATEWAY_CLIENT_ROLE,
          scopes: GATEWAY_CLIENT_SCOPES,
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: gatewayToken.trim() },
          userAgent: "pinai-cron-snapshot",
          locale: "en-US",
        },
      }));
    });

    ws.on("message", (raw) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(String(raw)); } catch { return; }
      if (!data || typeof data !== "object") return;

      // Step 1 response: connect OK → send cron.list
      if (data.type === "res" && data.id === CONNECT_REQUEST_ID) {
        if (!data.ok) { clearTimeout(timeout); finish(null); return; }
        ws.send(JSON.stringify({
          type: "req",
          id: CRON_LIST_REQUEST_ID,
          method: "cron.list",
          params: { enabled: "enabled" },
        }));
        return;
      }

      // Step 2 response: cron.list → extract earliest nextRunAtMs
      if (data.type === "res" && data.id === CRON_LIST_REQUEST_ID) {
        clearTimeout(timeout);
        if (!data.ok) { finish(null); return; }

        const result = data.result as { items?: unknown[] } | unknown[] | undefined;
        const items = Array.isArray(result)
          ? result
          : Array.isArray(result?.items)
            ? result.items
            : [];

        let earliest: number | null = null;
        const nowMs = Date.now();
        for (const item of items) {
          const job = item as { enabled?: boolean; state?: { nextRunAtMs?: number } };
          if (job.enabled === false) continue;
          const nextMs = job.state?.nextRunAtMs;
          if (typeof nextMs !== "number" || !Number.isFinite(nextMs)) continue;
          if (nextMs <= nowMs) continue; // skip past-due
          if (earliest === null || nextMs < earliest) earliest = nextMs;
        }
        finish(earliest);
      }
    });
  });
}

/**
 * Snapshot the earliest cron next-run time into `runtime_instances.metadata`.
 * Clears the key when no upcoming cron jobs exist to prevent stale wakes.
 * Fire-and-forget safe — callers should catch errors.
 */
export async function snapshotCronNextRun(
  assistantId: number,
  target: GatewayTarget,
  gatewayToken: string,
): Promise<void> {
  const nextMs = await fetchEarliestCronNextRunMs(target, gatewayToken);
  if (nextMs != null) {
    await setAssistantRuntimeMetadataKey(assistantId, "cronNextRunMs", nextMs);
  } else {
    await deleteAssistantRuntimeMetadataKey(assistantId, "cronNextRunMs");
  }
}
