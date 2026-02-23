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
