import crypto from 'node:crypto';
import { createSupabasePool, requireSupabaseDbUrl } from '../supabase/index.js';
import { config } from '../config.js';

export type Queryable = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

export const nowIso = (): string => new Date().toISOString();
export const randomToken = (size = 24): string => crypto.randomBytes(size).toString('hex');

const dbUrl = requireSupabaseDbUrl(
  config.supabase.dbUrl,
  'Missing SUPABASE_DB_URL. API server requires Supabase Postgres connection.'
);

export const pool = createSupabasePool(dbUrl, { max: 12, idleTimeoutMillis: 30_000 });
pool.on('error', (error: Error) => {
  console.error('[db] idle client error', error);
});

/**
 * Build a SQL `SET col1 = $1, col2 = $2` clause from a partial fields map.
 *
 * Used by repositories to assemble parameterised UPDATE statements without
 * concatenating untrusted column names. Only columns in `allowedColumns`
 * are emitted; everything else is dropped silently.
 */
export const buildAssignments = <T extends string>(
  fields: Partial<Record<T, unknown>>,
  allowedColumns: readonly T[]
): { sql: string; values: unknown[]; columns: T[] } => {
  const entries = Object.entries(fields)
    .filter((entry): entry is [T, unknown] => allowedColumns.includes(entry[0] as T))
    .filter(([, value]) => value !== undefined);

  if (!entries.length) {
    return { sql: '', values: [], columns: [] };
  }

  const sql = entries.map(([key], idx) => `${key} = $${idx + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  const columns = entries.map(([key]) => key);
  return { sql, values, columns };
};

export const fetchOne = async <T>(queryable: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> => {
  const result = await queryable.query<T>(sql, params);
  return result.rows[0];
};
