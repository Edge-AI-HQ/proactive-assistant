import { pool, withSchema } from './core.js';

export const listUsedPorts = async (): Promise<number[]> => {
  await withSchema();
  const result = await pool.query<{ host_port: number }>(
    `
      SELECT host_port
      FROM runtime_instances
      WHERE host_port > 0
        AND scope = 'assistant'
    `
  );

  return result.rows.map((row: { host_port: number }) => row.host_port);
};

type UnknownRecord = Record<string, unknown>;

export const readAssistantRuntimeMetadata = async (
  assistantId: number,
): Promise<UnknownRecord> => {
  await withSchema();
  const result = await pool.query<{ metadata: UnknownRecord }>(
    `
      SELECT COALESCE(runtime_instances.metadata, '{}'::jsonb) AS metadata
      FROM runtime_instances
      WHERE runtime_instances.assistant_id = $1
        AND runtime_instances.scope = 'assistant'
      LIMIT 1
    `,
    [assistantId],
  );
  return result.rows[0]?.metadata || {};
};

export const setAssistantRuntimeMetadataKey = async (
  assistantId: number,
  key: string,
  value: unknown,
): Promise<UnknownRecord> => {
  await withSchema();

  const result = await pool.query<{ metadata: UnknownRecord }>(
    `
      UPDATE runtime_instances
      SET
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          ARRAY[$2::text],
          $3::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE assistant_id = $1
        AND scope = 'assistant'
      RETURNING metadata
    `,
    [assistantId, key, JSON.stringify(value ?? null)],
  );

  if (!result.rows[0]) {
    throw new Error(`Assistant runtime ${assistantId} not found`);
  }

  return result.rows[0].metadata || {};
};

export const deleteAssistantRuntimeMetadataKey = async (
  assistantId: number,
  key: string,
): Promise<boolean> => {
  await withSchema();

  const result = await pool.query(
    `
      UPDATE runtime_instances
      SET
        metadata = COALESCE(metadata, '{}'::jsonb) - $2::text,
        updated_at = NOW()
      WHERE assistant_id = $1
        AND scope = 'assistant'
        AND (COALESCE(metadata, '{}'::jsonb) ? $2::text)
      RETURNING 1
    `,
    [assistantId, key],
  );

  return (result.rowCount ?? 0) > 0;
};

// ---------------------------------------------------------------------------
// Idle-suspend: last_active_at tracking + idle scan
// ---------------------------------------------------------------------------

/**
 * Touch last_active_at for an assistant's runtime instance.
 * Called on every outbound Telegram API proxy response.
 * Fire-and-forget safe — failures are logged but not thrown.
 */
export const touchAssistantLastActiveAt = async (
  assistantId: number,
): Promise<void> => {
  await pool.query(
    `
      UPDATE runtime_instances
      SET last_active_at = NOW()
      WHERE assistant_id = $1
        AND scope = 'assistant'
    `,
    [assistantId],
  );
};

export interface IdleAssistantRow {
  assistant_id: number;
  assistant_bot_id: number;
  container_name: string;
  container_id: string;
}

/**
 * Find running assistant containers that have been idle longer than the given threshold.
 * Returns rows suitable for passing to the orchestrator's suspendAssistantContainer.
 */
export const findIdleRunningAssistants = async (
  idleThresholdMs: number,
): Promise<IdleAssistantRow[]> => {
  const result = await pool.query<IdleAssistantRow>(
    `
      SELECT
        r.assistant_id,
        a.assistant_bot_id,
        r.container_name,
        COALESCE(r.runtime_ref, '') as container_id
      FROM runtime_instances r
      JOIN assistants a ON a.id = r.assistant_id
      WHERE r.scope = 'assistant'
        AND r.status = 'running'
        AND r.last_active_at IS NOT NULL
        AND r.last_active_at < NOW() - make_interval(secs => $1::double precision / 1000)
    `,
    [idleThresholdMs],
  );
  return result.rows;
};

export const setAssistantRuntimeMetadataKeyIfAbsent = async (
  assistantId: number,
  key: string,
  value: unknown,
): Promise<boolean> => {
  await withSchema();

  const result = await pool.query(
    `
      UPDATE runtime_instances
      SET
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          ARRAY[$2::text],
          $3::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE assistant_id = $1
        AND scope = 'assistant'
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? $2::text)
      RETURNING 1
    `,
    [assistantId, key, JSON.stringify(value ?? null)],
  );

  return (result.rowCount ?? 0) > 0;
};
