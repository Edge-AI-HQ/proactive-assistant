import { Pool, types, type PoolConfig } from 'pg';

let parsersConfigured = false;

export const configurePgTypeParsers = (): void => {
  if (parsersConfigured) return;

  // Parse bigint/numeric columns into JS numbers for telemetry and IDs.
  types.setTypeParser(20, (value) => Number(value));
  types.setTypeParser(1700, (value) => Number(value));

  parsersConfigured = true;
};

export const requireSupabaseDbUrl = (value: string | undefined, errorMessage = 'Missing SUPABASE_DB_URL'): string => {
  const dbUrl = (value || '').trim();
  if (!dbUrl) {
    throw new Error(errorMessage);
  }
  return dbUrl;
};

export interface SupabasePoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
}

export const createSupabasePool = (
  connectionString: string,
  options: SupabasePoolOptions = {}
): Pool => {
  configurePgTypeParsers();

  const config: PoolConfig = {
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000
  };

  return new Pool(config);
};
