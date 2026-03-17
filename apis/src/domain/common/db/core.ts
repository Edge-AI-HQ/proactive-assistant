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

export const PORT_ALLOC_LOCK_KEY = 319_901;

const dbUrl = requireSupabaseDbUrl(
  config.supabase.dbUrl,
  'Missing SUPABASE_DB_URL. API server requires Supabase Postgres connection.'
);

export const pool = createSupabasePool(dbUrl, { max: 12, idleTimeoutMillis: 30_000 });
pool.on('error', (error: Error) => {
  console.error('[db] idle client error', error);
});

export const withSchema = async (): Promise<void> => {
  // Schema ownership is migration-only under apis/db/migrations.
  return Promise.resolve();
};

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

export const userSelectColumns = `
  users.id,
  users.telegram_user_id,
  users.telegram_username,
  users.litellm_user_id,
  users.litellm_user_alias,
  users.litellm_key_alias,
  users.litellm_virtual_key,
  users.litellm_key_last4,
  users.litellm_spend_usd,
  users.litellm_budget_usd,
  users.litellm_budget_duration,
  users.litellm_rpm_limit,
  users.litellm_tpm_limit,
  users.litellm_last_synced_at,
  COALESCE(user_runtime.runtime_ref, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS container_id,
  COALESCE(user_runtime.host_port, -ABS(users.telegram_user_id)) AS container_port,
  COALESCE(user_runtime.status, 'idle') AS container_status,
  users.gateway_token,
  users.created_at,
  users.last_active_at
`;

export const userFromClause = `
  FROM users
  LEFT JOIN runtime_instances AS user_runtime
    ON user_runtime.owner_user_id = users.id
   AND user_runtime.scope = 'user'
`;

export const assistantSelectColumns = `
  assistants.id,
  owners.telegram_user_id AS owner_telegram_user_id,
  assistants.assistant_bot_id,
  assistants.assistant_bot_token,
  assistants.assistant_bot_username,
  assistants.litellm_user_id,
  assistants.litellm_key_alias,
  assistants.litellm_virtual_key,
  assistants.litellm_key_last4,
  assistants.litellm_spend_usd,
  assistants.litellm_budget_usd,
  assistants.litellm_budget_duration,
  assistants.litellm_rpm_limit,
  assistants.litellm_tpm_limit,
  assistants.litellm_last_synced_at,
  COALESCE(assistant_runtime.container_name, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_name,
  COALESCE(assistant_runtime.runtime_ref, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_id,
  COALESCE(assistant_runtime.host_port, 0) AS container_port,
  COALESCE(assistant_runtime.status, 'creating') AS container_status,
  assistants.created_at,
  assistants.updated_at
`;

export const assistantFromClause = `
  FROM assistants
  JOIN users AS owners
    ON owners.id = assistants.owner_user_id
  LEFT JOIN runtime_instances AS assistant_runtime
    ON assistant_runtime.assistant_id = assistants.id
   AND assistant_runtime.scope = 'assistant'
`;

export const resolveUserIdByTelegramId = async (queryable: Queryable, telegramUserId: number): Promise<number | undefined> => {
  const row = await fetchOne<{ id: number }>(queryable, 'SELECT id FROM users WHERE telegram_user_id = $1', [telegramUserId]);
  return row?.id;
};

export const resolveUserByLiteLLMUserId = async (
  queryable: Queryable,
  litellmUserId: string
): Promise<{ id: number; telegram_user_id: number } | undefined> => {
  const normalized = litellmUserId.trim();
  if (!normalized) return undefined;
  return fetchOne<{ id: number; telegram_user_id: number }>(
    queryable,
    'SELECT id, telegram_user_id FROM users WHERE litellm_user_id = $1',
    [normalized]
  );
};

export const allocatePortInTransaction = async (queryable: Queryable): Promise<number> => {
  await queryable.query('SELECT pg_advisory_xact_lock($1)', [PORT_ALLOC_LOCK_KEY]);

  const usedResult = await queryable.query<{ host_port: number }>(
    `
      SELECT host_port
      FROM runtime_instances
      WHERE host_port BETWEEN $1 AND $2
      ORDER BY host_port ASC
    `,
    [config.container.portStart, config.container.portEnd]
  );

  const used = new Set(usedResult.rows.map((row) => row.host_port));
  for (let port = config.container.portStart; port <= config.container.portEnd; port += 1) {
    if (!used.has(port)) return port;
  }

  throw new Error('No available container ports in configured range');
};

export const readAssistantRuntime = async (
  queryable: Queryable,
  assistantId: number
): Promise<
  | {
      owner_user_id: number;
      assistant_bot_id: number;
      container_name: string;
      runtime_ref: string;
      host_port: number;
      status: string;
    }
  | undefined
> => {
  return fetchOne<{
    owner_user_id: number;
    assistant_bot_id: number;
    container_name: string;
    runtime_ref: string;
    host_port: number;
    status: string;
  }>(
    queryable,
    `
      SELECT
        assistants.owner_user_id,
        assistants.assistant_bot_id,
        COALESCE(runtime_instances.container_name, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS container_name,
        COALESCE(runtime_instances.runtime_ref, CONCAT('pinclaw-bot-', assistants.assistant_bot_id::text)) AS runtime_ref,
        COALESCE(runtime_instances.host_port, 0) AS host_port,
        COALESCE(runtime_instances.status, 'creating') AS status
      FROM assistants
      LEFT JOIN runtime_instances
        ON runtime_instances.assistant_id = assistants.id
       AND runtime_instances.scope = 'assistant'
      WHERE assistants.id = $1
    `,
    [assistantId]
  );
};

export const readUserRuntime = async (
  queryable: Queryable,
  telegramUserId: number
): Promise<
  | {
      user_id: number;
      telegram_user_id: number;
      container_name: string;
      runtime_ref: string;
      host_port: number;
      status: string;
    }
  | undefined
> => {
  return fetchOne<{
    user_id: number;
    telegram_user_id: number;
    container_name: string;
    runtime_ref: string;
    host_port: number;
    status: string;
  }>(
    queryable,
    `
      SELECT
        users.id AS user_id,
        users.telegram_user_id,
        COALESCE(runtime_instances.container_name, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS container_name,
        COALESCE(runtime_instances.runtime_ref, CONCAT('openclaw-user-', users.telegram_user_id::text)) AS runtime_ref,
        COALESCE(runtime_instances.host_port, -ABS(users.telegram_user_id)) AS host_port,
        COALESCE(runtime_instances.status, 'idle') AS status
      FROM users
      LEFT JOIN runtime_instances
        ON runtime_instances.owner_user_id = users.id
       AND runtime_instances.scope = 'user'
      WHERE users.telegram_user_id = $1
      FOR UPDATE
    `,
    [telegramUserId]
  );
};
