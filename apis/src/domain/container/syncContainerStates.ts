import { pool } from "../common/db/core.js";
import { getOrchestrator } from "./service.js";

const SYNC_LOCK_KEY = 319_902;

/**
 * List assistants in batches from the database.
 */
async function listAssistantsWithLimit(
  offset: number,
  limit: number,
): Promise<
  Array<{
    id: number;
    assistant_bot_id: number;
    container_status: string;
    container_id: string;
    owner_telegram_user_id: string | null;
  }>
> {
  const result = await pool.query<{
    id: number;
    assistant_bot_id: number;
    container_status: string;
    container_id: string;
    owner_telegram_user_id: string | null;
  }>(
    `
      SELECT
        assistants.id,
        assistants.assistant_bot_id,
        COALESCE(runtime_instances.status, 'creating') as container_status,
        COALESCE(runtime_instances.runtime_ref, '') as container_id,
        users.telegram_user_id::text as owner_telegram_user_id
      FROM assistants
      LEFT JOIN runtime_instances ON runtime_instances.assistant_id = assistants.id
      LEFT JOIN users ON users.id = assistants.owner_user_id
      ORDER BY assistants.id ASC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );
  return result.rows;
}

/**
 * Sync container states using the orchestrator (runtime-agnostic).
 *
 * Uses PostgreSQL advisory lock for cluster-safe single-leader execution.
 */
export async function syncContainerStates(): Promise<void> {
  const client = await pool.connect();
  try {
    const lockResult = await client.query<{ got_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1) as got_lock",
      [SYNC_LOCK_KEY],
    );

    if (!lockResult.rows[0]?.got_lock) {
      console.log(
        "[container] State sync already running in another instance, skipping",
      );
      return;
    }

    try {
      const result = await getOrchestrator().syncContainerStates(
        listAssistantsWithLimit,
      );
      if (result.synced > 0 || result.errors > 0) {
        console.log("[container] State sync completed", result);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
