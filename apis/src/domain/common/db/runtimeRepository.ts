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
