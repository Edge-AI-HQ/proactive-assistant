import {
  touchAssistantLastActiveAt,
  findIdleRunningAssistants,
  findSuspendedWithUpcomingCron,
  deleteAssistantRuntimeMetadataKey,
} from "../common/db/runtimeRepository.js";
import { pool } from "../common/db/core.js";
import { getOrchestrator } from "./service.js";
import { snapshotCronNextRun } from "./cron_snapshot.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let idleSuspendMs = 30_000; // default 30s for testing

export const configureIdleSuspendMs = (ms: number): void => {
  idleSuspendMs = ms;
};

export const getIdleSuspendMs = (): number => idleSuspendMs;

/** Look-ahead window for wake-on-cron (ms). */
const CRON_WAKE_LOOKAHEAD_MS = 60_000;

// ---------------------------------------------------------------------------
// Activity recording (DB-based, multi-instance safe)
// ---------------------------------------------------------------------------

/**
 * Record outbound activity for an assistant.
 * Writes last_active_at to DB so any API instance can see it.
 * Fire-and-forget — errors are logged, not thrown.
 */
export const recordAssistantActivity = (assistantId: number): void => {
  touchAssistantLastActiveAt(assistantId).catch((error) => {
    console.warn(
      `[idle-suspend] Failed to touch last_active_at for assistant ${assistantId}`,
      error,
    );
  });
};

// ---------------------------------------------------------------------------
// Combined periodic scan: wake-on-cron + idle-suspend
// (cluster-safe via PostgreSQL advisory lock)
// ---------------------------------------------------------------------------

const IDLE_SUSPEND_LOCK_KEY = 319_903;

/**
 * Combined scan that runs under a single advisory lock:
 *   1. Wake suspended containers whose cron jobs are about to fire
 *   2. Suspend idle running containers (with pre-suspend cron snapshot)
 *
 * Order matters: wake first so we don't immediately re-suspend a container
 * that should be waking up.
 */
export async function scanIdleAndCron(): Promise<void> {
  if (idleSuspendMs <= 0) return;

  const client = await pool.connect();
  let destroyClient = false;
  try {
    const lockResult = await client.query<{ got_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1) as got_lock",
      [IDLE_SUSPEND_LOCK_KEY],
    );

    if (!lockResult.rows[0]?.got_lock) {
      return; // another instance is scanning
    }

    try {
      // Phase 1: wake suspended containers with imminent cron jobs
      const wokenIds = await doWakeForCron();

      // Phase 2: suspend idle running containers (skip any just woken)
      await doSuspendIdle(wokenIds);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          IDLE_SUSPEND_LOCK_KEY,
        ]);
      } catch (unlockErr) {
        // If unlock fails, the session-level lock is stuck on this connection.
        // Destroy the connection instead of returning it to the pool, otherwise
        // the leaked lock permanently blocks all future scans.
        console.error(
          "[scan] Failed to release advisory lock, destroying connection to prevent leak",
          unlockErr,
        );
        destroyClient = true;
      }
    }
  } catch (error) {
    console.error("[scan] Combined idle/cron scan failed", error);
  } finally {
    client.release(destroyClient);
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Wake-on-cron
// ---------------------------------------------------------------------------

async function doWakeForCron(): Promise<Set<number>> {
  const wokenIds = new Set<number>();

  try {
    const rows = await findSuspendedWithUpcomingCron(
      Date.now(),
      CRON_WAKE_LOOKAHEAD_MS,
    );
    if (!rows.length) return wokenIds;

    const orchestrator = getOrchestrator();

    for (const row of rows) {
      try {
        const leadMs = row.cron_next_run_ms - Date.now();
        const label = leadMs > 0 ? `due in ${leadMs}ms` : `past-due by ${-leadMs}ms`;
        console.log(
          `[wake-on-cron] Waking assistant ${row.assistant_id} — cron ${label}`,
        );

        const { resumed } = await orchestrator.resumeAssistantContainer({
          id: row.assistant_id,
          assistant_bot_id: row.assistant_bot_id,
          container_name: row.container_name,
          container_id: row.container_id,
        });

        if (resumed) {
          // Clear stale cronNextRunMs — container will get a fresh snapshot
          // on next suspend. This prevents re-wake loops if resume succeeded
          // but DB status update lagged.
          await deleteAssistantRuntimeMetadataKey(row.assistant_id, "cronNextRunMs");

          // Must await — fire-and-forget risks stale last_active_at causing
          // immediate re-suspend on the next scan cycle (30s later).
          await touchAssistantLastActiveAt(row.assistant_id);

          wokenIds.add(row.assistant_id);
          console.log(
            `[wake-on-cron] Resumed assistant ${row.assistant_id} for upcoming cron job`,
          );
        }
      } catch (error) {
        console.error(
          `[wake-on-cron] Failed to wake assistant ${row.assistant_id}`,
          error,
        );
      }
    }
  } catch (error) {
    console.error("[wake-on-cron] Cron wake scan failed", error);
  }

  return wokenIds;
}

// ---------------------------------------------------------------------------
// Phase 2: Idle suspend (with pre-suspend cron snapshot)
// ---------------------------------------------------------------------------

async function doSuspendIdle(skipIds: Set<number>): Promise<void> {
  const idleAssistants = await findIdleRunningAssistants(idleSuspendMs);
  if (!idleAssistants.length) return;

  console.log(
    `[idle-suspend] Found ${idleAssistants.length} idle assistant(s), suspending...`,
  );

  const orchestrator = getOrchestrator();

  for (const row of idleAssistants) {
    if (skipIds.has(row.assistant_id)) continue;

    try {
      // Pre-suspend: snapshot cron schedule so wake-on-cron knows when to resume
      if (row.gateway_token) {
        try {
          const target = orchestrator.resolveGatewayTargetForAssistant({
            assistant_bot_id: row.assistant_bot_id,
            container_id: row.container_id,
            container_port: row.host_port,
          });
          await snapshotCronNextRun(row.assistant_id, target, row.gateway_token);
        } catch (err) {
          console.warn(
            `[idle-suspend] Failed to snapshot cron for assistant ${row.assistant_id} (non-fatal)`,
            err,
          );
        }
      }

      const { suspended } = await orchestrator.suspendAssistantContainer({
        id: row.assistant_id,
        assistant_bot_id: row.assistant_bot_id,
        container_name: row.container_name,
        container_id: row.container_id,
      });

      if (suspended) {
        console.log(
          `[idle-suspend] Suspended container for assistant ${row.assistant_id}`,
        );
      }
    } catch (error) {
      console.error(
        `[idle-suspend] Failed to suspend assistant ${row.assistant_id}`,
        error,
      );
    }
  }
}
