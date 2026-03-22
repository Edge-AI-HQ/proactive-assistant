import {
  touchAssistantLastActiveAt,
  findIdleRunningAssistants,
} from "../common/db/runtimeRepository.js";
import { pool } from "../common/db/core.js";
import { getOrchestrator } from "./service.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

let idleSuspendMs = 30_000; // default 30s for testing

export const configureIdleSuspendMs = (ms: number): void => {
  idleSuspendMs = ms;
};

export const getIdleSuspendMs = (): number => idleSuspendMs;

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
// Periodic idle scan (cluster-safe via PostgreSQL advisory lock)
// ---------------------------------------------------------------------------

const IDLE_SUSPEND_LOCK_KEY = 319_903;

/**
 * Scan for running containers that have been idle beyond the threshold,
 * and suspend them. Uses pg_try_advisory_lock so only one API instance
 * runs the scan at a time — others skip silently.
 */
export async function scanAndSuspendIdle(): Promise<void> {
  if (idleSuspendMs <= 0) return;

  const client = await pool.connect();
  try {
    const lockResult = await client.query<{ got_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1) as got_lock",
      [IDLE_SUSPEND_LOCK_KEY],
    );

    if (!lockResult.rows[0]?.got_lock) {
      return; // another instance is scanning
    }

    try {
      const idleAssistants = await findIdleRunningAssistants(idleSuspendMs);
      if (!idleAssistants.length) return;

      console.log(
        `[idle-suspend] Found ${idleAssistants.length} idle assistant(s), suspending...`,
      );

      const orchestrator = getOrchestrator();

      for (const row of idleAssistants) {
        try {
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
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [
        IDLE_SUSPEND_LOCK_KEY,
      ]);
    }
  } catch (error) {
    console.error("[idle-suspend] Idle scan failed", error);
  } finally {
    client.release();
  }
}
